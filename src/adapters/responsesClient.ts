import * as vscode from "vscode";
import type { LiteLLMConfig, LiteLLMResponsesRequest, LiteLLMModelInfo } from "../types";
import { tryParseJSONObject } from "../utils";
import { Logger } from "../utils/logger";
import { isAnthropicModel } from "../utils/modelUtils";

export interface ResponsesEvent {
    type: string;
    delta?: string;
    text?: string;
    chunk?: string;
    item?: Record<string, unknown>;
    choices?: Record<string, unknown>[];
    output?: Record<string, unknown>[];
}

export class ResponsesClient {
    private readonly toolCallsInProgress = new Map<
        string,
        {
            name?: string;
            argsBuffer: string;
        }
    >();

    /**
     * Fallback state for providers that stream tool args before emitting a stable call id.
     *
     * Note: If the upstream stream interleaves multiple tool calls without call ids,
     * there is no reliable way to disambiguate them.
     */
    private anonymousToolArgsBuffer = "";
    private anonymousToolName: string | undefined;

    constructor(
        private readonly config: LiteLLMConfig,
        private readonly userAgent: string
    ) {}

    /**
     * Sends a request to the LiteLLM /responses endpoint and handles the SSE stream.
     */
    async sendResponsesRequest(
        request: LiteLLMResponsesRequest,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        modelInfo?: LiteLLMModelInfo
    ): Promise<void> {
        const response = await fetch(`${this.config.url}/responses`, {
            method: "POST",
            headers: this.getHeaders(request.model, modelInfo),
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LiteLLM Responses API error: ${response.status} ${response.statusText}\n${errorText}`);
        }

        if (!response.body) {
            throw new Error("No response body from LiteLLM Responses API");
        }

        await this.parseSSEStream(response.body, progress, token);
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

    private async parseSSEStream(
        stream: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done || token.isCancellationRequested) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data: ")) {
                        continue;
                    }

                    const data = trimmed.slice(6);
                    if (data === "[DONE]") {
                        continue;
                    }

                    try {
                        const event = JSON.parse(data) as ResponsesEvent;
                        await this.handleEvent(event, progress);
                    } catch (e) {
                        Logger.error("Failed to parse SSE data", e, data);
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    private async handleEvent(
        event: ResponsesEvent,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): Promise<void> {
        const type = event.type;

        // Handle text output
        if (type === "response.output_text.delta") {
            const text = event.delta || event.text || event.chunk;
            if (text) {
                progress.report(new vscode.LanguageModelTextPart(text));
            }
        }
        // Handle reasoning/thought output
        else if (type === "response.output_reasoning.delta") {
            const reasoning = event.delta || event.text || event.chunk;
            if (reasoning) {
                // Format reasoning as italicized text to distinguish it
                progress.report(new vscode.LanguageModelTextPart(`*${reasoning}*`));
            }
        }
        // Handle tool call parts (buffering arguments)
        else if (type === "response.output_item.delta") {
            const item = event.item;
            if (item?.type === "function_call") {
                const callId = typeof item.call_id === "string" ? item.call_id : undefined;
                const name = typeof item.name === "string" ? item.name : undefined;
                const argsDelta = typeof item.arguments === "string" ? item.arguments : undefined;

                if (callId) {
                    const state = this.toolCallsInProgress.get(callId) ?? { argsBuffer: "" };
                    if (name) {
                        state.name = name;
                    }
                    if (argsDelta) {
                        state.argsBuffer += argsDelta;
                    }
                    this.toolCallsInProgress.set(callId, state);
                } else {
                    // No call id yet; keep a best-effort anonymous buffer.
                    if (name) {
                        this.anonymousToolName = name;
                    }
                    if (argsDelta) {
                        this.anonymousToolArgsBuffer += argsDelta;
                    }
                }
            }
        }
        // Handle tool call completion
        else if (type === "response.output_item.done") {
            const item = event.item;
            if (item?.type === "function_call") {
                const callId = typeof item.call_id === "string" ? item.call_id : undefined;
                const nameFromDone = typeof item.name === "string" ? item.name : undefined;
                const argsFromDone = typeof item.arguments === "string" ? item.arguments : undefined;

                if (callId) {
                    const state = this.toolCallsInProgress.get(callId);
                    const name = nameFromDone ?? state?.name;
                    const args = argsFromDone ?? state?.argsBuffer;

                    if (name && args) {
                        const parsed = tryParseJSONObject(args);
                        if (parsed.ok) {
                            progress.report(new vscode.LanguageModelToolCallPart(callId, name, parsed.value));
                        }
                    }

                    this.toolCallsInProgress.delete(callId);
                } else {
                    // Best-effort anonymous done (no stable id)
                    const name = nameFromDone ?? this.anonymousToolName;
                    const args = argsFromDone ?? this.anonymousToolArgsBuffer;
                    if (name && args) {
                        const parsed = tryParseJSONObject(args);
                        if (parsed.ok) {
                            // If upstream doesn't provide an id, emit a deterministic placeholder.
                            progress.report(new vscode.LanguageModelToolCallPart("anonymous", name, parsed.value));
                        }
                    }
                }

                // Reset anonymous buffer (regardless of whether we emitted)
                this.anonymousToolArgsBuffer = "";
                this.anonymousToolName = undefined;
            }
        }
    }
}
