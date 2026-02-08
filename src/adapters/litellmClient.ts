import type * as vscode from "vscode";
import type {
    LiteLLMConfig,
    LiteLLMModelInfoResponse,
    OpenAIChatCompletionRequest,
    LiteLLMResponsesRequest,
    LiteLLMModelInfo,
} from "../types";
import { transformToResponsesFormat } from "./responsesAdapter";
import { Logger } from "../utils/logger";
import { isAnthropicModel } from "../utils/modelUtils";
import { LiteLLMTelemetry } from "../utils/telemetry";

export class LiteLLMClient {
    constructor(
        private readonly config: LiteLLMConfig,
        private readonly userAgent: string
    ) {}

    /**
     * Fetches model information from the LiteLLM proxy.
     */
    async getModelInfo(token?: vscode.CancellationToken): Promise<LiteLLMModelInfoResponse> {
        const controller = new AbortController();
        if (token) {
            token.onCancellationRequested(() => controller.abort());
        }

        Logger.trace(`Fetching model info from ${this.config.url}/model/info`);
        const resp = await fetch(`${this.config.url}/model/info`, {
            headers: this.getHeaders(),
            signal: controller.signal,
        });
        if (!resp.ok) {
            Logger.error(`Failed to fetch model info: ${resp.status} ${resp.statusText}`);
            throw new Error(`Failed to fetch model info: ${resp.status} ${resp.statusText}`);
        }
        return resp.json() as Promise<LiteLLMModelInfoResponse>;
    }

    /**
     * Sends a chat request to the LiteLLM proxy.
     */
    async chat(
        request: OpenAIChatCompletionRequest,
        mode?: string,
        token?: vscode.CancellationToken,
        modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        const endpoint = this.getEndpoint(mode);
        let body: OpenAIChatCompletionRequest | LiteLLMResponsesRequest = request;

        const isAnthropic = isAnthropicModel(request.model, modelInfo);

        if (this.config.disableCaching) {
            if (isAnthropic) {
                Logger.info(`Bypassing 'disable caching' for Anthropic/Claude model: ${request.model}`);
                LiteLLMTelemetry.reportMetric({
                    requestId: `bypass-${Math.random().toString(36).substring(7)}`,
                    model: request.model,
                    status: "caching_bypassed",
                });
            } else {
                body.no_cache = true;
                body["no-cache"] = true;
            }
        }

        if (endpoint === "/responses") {
            body = transformToResponsesFormat(request);
            if (this.config.disableCaching && !isAnthropic) {
                body.no_cache = true;
                body["no-cache"] = true;
            }
        }

        Logger.trace(`Sending chat request to ${endpoint}`, { model: request.model });
        let response = await this.fetchWithRateLimit(
            `${this.config.url}${endpoint}`,
            {
                method: "POST",
                headers: this.getHeaders(request.model, modelInfo),
                body: JSON.stringify(body),
            },
            { token }
        );

        // Handle unsupported parameters by stripping them and retrying once
        if (response.status === 400) {
            const errorText = await response.clone().text();
            const errorLower = errorText.toLowerCase();

            if (
                errorLower.includes("unsupported parameter") ||
                errorLower.includes("extra_headers") ||
                errorLower.includes("no-cache") ||
                errorLower.includes("unexpected keyword argument")
            ) {
                Logger.warn(`Detected unsupported parameters for ${request.model}, attempting to strip and retry.`);

                const strippedBody = JSON.parse(JSON.stringify(body));
                const headers = this.getHeaders(request.model, modelInfo);

                // 1. Handle explicit mentions of parameters in the error message
                // Common patterns: "unsupported parameter: 'temperature'", "unexpected keyword argument 'top_p'"
                const paramMatch = errorText.match(/(?:parameter|argument|key)\s+['"]?([a-zA-Z0-9_-]+)['"]?/i);
                if (paramMatch && paramMatch[1]) {
                    const paramName = paramMatch[1];
                    Logger.info(`Stripping specific parameter: ${paramName}`);
                    delete strippedBody[paramName];
                }

                // 2. Always strip caching if mentioned or if it was a likely culprit
                if (errorLower.includes("no-cache") || errorLower.includes("no_cache")) {
                    delete strippedBody.no_cache;
                    delete strippedBody["no-cache"];
                    delete headers["Cache-Control"];
                }

                // 3. Fallback: if we couldn't identify a specific param but it's a 400,
                // we might want to strip common problematic ones if they exist,
                // but for now we rely on the regex match above.

                response = await this.fetchWithRateLimit(
                    `${this.config.url}${endpoint}`,
                    {
                        method: "POST",
                        headers: headers,
                        body: JSON.stringify(strippedBody),
                    },
                    { token }
                );
            }
        }

        if (!response.ok) {
            const errorText = await response.text();
            Logger.error(`LiteLLM API error: ${response.status} ${response.statusText}`, errorText);
            throw new Error(`LiteLLM API error: ${response.status} ${response.statusText}\n${errorText}`);
        }

        if (!response.body) {
            Logger.error("No response body from LiteLLM API");
            throw new Error("No response body from LiteLLM API");
        }

        return response.body as ReadableStream<Uint8Array>;
    }

    private getHeaders(modelId?: string, modelInfo?: LiteLLMModelInfo): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
        };
        if (this.config.key) {
            headers.Authorization = `Bearer ${this.config.key}`;
            headers["X-API-Key"] = this.config.key;
        }
        if (this.config.disableCaching) {
            const isAnthropic = modelId ? isAnthropicModel(modelId, modelInfo) : false;
            if (!isAnthropic) {
                headers["Cache-Control"] = "no-cache";
            }
        }
        return headers;
    }

    private getEndpoint(mode?: string): string {
        if (mode === "chat" || mode === "completions") {
            return "/chat/completions";
        }
        if (mode === "responses") {
            return "/responses";
        }
        // Default to chat/completions for backward compatibility
        return "/chat/completions";
    }

    private async fetchWithRetry(
        url: string,
        init: RequestInit,
        options?: { retries?: number; delayMs?: number; token?: vscode.CancellationToken }
    ): Promise<Response> {
        const maxRetries = options?.retries ?? 2;
        const delayMs = options?.delayMs ?? 1000;
        let attempt = 0;
        while (true) {
            if (options?.token?.isCancellationRequested) {
                throw new Error("Operation cancelled by user");
            }

            const controller = new AbortController();
            const disposable = options?.token?.onCancellationRequested(() => controller.abort());

            try {
                const response = await fetch(url, { ...init, signal: controller.signal });
                if (response.ok || attempt >= maxRetries || response.status < 500 || response.status >= 600) {
                    return response;
                }
                attempt++;
                await this.sleep(delayMs, options?.token);
            } catch (err: unknown) {
                if (err instanceof Error && err.name === "AbortError") {
                    throw new Error("Operation cancelled by user");
                }
                if (attempt >= maxRetries) {
                    throw err;
                }
                attempt++;
                await this.sleep(delayMs, options?.token);
            } finally {
                disposable?.dispose();
            }
        }
    }

    /**
     * Fetch with exponential back-off for rate limiting (429).
     * Retries with exponential delay up to a maximum cumulative delay of 2 minutes.
     * For other transient errors, it delegates to {@link fetchWithRetry}.
     */
    async fetchWithRateLimit(
        url: string,
        init: RequestInit,
        options?: { maxTotalDelayMs?: number; initialDelayMs?: number; token?: vscode.CancellationToken }
    ): Promise<Response> {
        const maxTotalDelayMs = options?.maxTotalDelayMs ?? 120_000;
        const initialDelayMs = options?.initialDelayMs ?? 500;
        let cumulativeDelayMs = 0;
        let attempt = 0;

        while (true) {
            if (options?.token?.isCancellationRequested) {
                throw new Error("Operation cancelled by user");
            }

            const response = await this.fetchWithRetry(url, init, { token: options?.token });
            if (response.status !== 429) {
                return response;
            }

            const remaining = maxTotalDelayMs - cumulativeDelayMs;
            if (remaining <= 0) {
                return response;
            }

            const headerDelayMs = this.parseRetryAfterDelayMs(response);
            const exponentialDelayMs = initialDelayMs * Math.pow(2, attempt);
            const chosenDelay = headerDelayMs !== undefined ? headerDelayMs : exponentialDelayMs;
            const nextDelayMs = Math.min(Math.max(1, chosenDelay), remaining);

            attempt++;
            cumulativeDelayMs += nextDelayMs;
            await this.sleep(nextDelayMs, options?.token);
        }
    }

    private sleep(ms: number, token?: vscode.CancellationToken): Promise<void> {
        if (token?.isCancellationRequested) {
            return Promise.reject(new Error("Operation cancelled by user"));
        }
        return new Promise((resolve, reject) => {
            const registration = token?.onCancellationRequested(() => {
                clearTimeout(timer);
                registration?.dispose();
                reject(new Error("Operation cancelled by user"));
            });
            const timer = setTimeout(() => {
                registration?.dispose();
                resolve();
            }, ms);
        });
    }

    private parseRetryAfterDelayMs(response: Response): number | undefined {
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
            const secs = Number(retryAfter);
            if (!Number.isNaN(secs) && secs >= 0) {
                return secs * 1000;
            }
            const asDate = Date.parse(retryAfter);
            if (!Number.isNaN(asDate)) {
                const delta = asDate - Date.now();
                if (delta > 0) {
                    return delta;
                }
            }
        }
        return undefined;
    }
}
