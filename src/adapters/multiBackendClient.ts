import type * as vscode from "vscode";
import type {
    OpenAIChatCompletionRequest,
    LiteLLMModelInfo,
    LiteLLMTokenCounterRequest,
    LiteLLMTokenCounterResponse,
    ResolvedBackend,
} from "../types";
import { LiteLLMClient } from "./litellmClient";
import { Logger } from "../utils/logger";
import type { TelemetryService } from "../telemetry/telemetryService";

/**
 * Separator between backend name and original model ID in namespaced model IDs.
 */
export const BACKEND_MODEL_SEPARATOR = "/";

/**
 * Extracts the backend name and original model ID from a namespaced model ID.
 * Returns undefined if the model ID is not namespaced (legacy single-backend).
 */
export function parseNamespacedModelId(
    namespacedId: string,
    backendNames: string[]
): { backendName: string; originalModelId: string } | undefined {
    for (const name of backendNames) {
        const prefix = `${name}${BACKEND_MODEL_SEPARATOR}`;
        if (namespacedId.startsWith(prefix)) {
            return {
                backendName: name,
                originalModelId: namespacedId.slice(prefix.length),
            };
        }
    }
    return undefined;
}

/**
 * Creates a namespaced model ID from a backend name and original model ID.
 */
export function createNamespacedModelId(backendName: string, originalModelId: string): string {
    return `${backendName}${BACKEND_MODEL_SEPARATOR}${originalModelId}`;
}

/**
 * Aggregated model info from all backends, with namespaced model IDs.
 */
export interface AggregatedModelInfoResponse {
    data: Array<{
        model_info?: LiteLLMModelInfo;
        model_name?: string;
        /** The backend this model came from. */
        backendName: string;
        /** The namespaced model ID exposed to VS Code. */
        namespacedId: string;
    }>;
}

/**
 * Orchestrates multiple LiteLLM backend clients.
 * Routes requests to the correct backend based on model ID prefix.
 */
export class MultiBackendClient {
    private readonly clients = new Map<string, LiteLLMClient>();
    private readonly backendNames: string[] = [];
    private _telemetryService?: TelemetryService;

    constructor(
        backends: ResolvedBackend[],
        private readonly userAgent: string
    ) {
        for (const backend of backends) {
            const client = new LiteLLMClient({ url: backend.url, key: backend.apiKey }, userAgent);
            this.clients.set(backend.name, client);
            this.backendNames.push(backend.name);
        }
    }

    public setTelemetryService(service: TelemetryService): void {
        this._telemetryService = service;
        for (const client of this.clients.values()) {
            client.setTelemetryService(service);
        }
    }

    /**
     * Returns the number of active backends.
     */
    get backendCount(): number {
        return this.clients.size;
    }

    /**
     * Returns all backend names.
     */
    getBackendNames(): string[] {
        return [...this.backendNames];
    }

    /**
     * Fetches model info from all backends concurrently and aggregates results.
     * Model IDs are namespaced as "{backendName}/{originalModelId}".
     */
    async getModelInfoAll(token?: vscode.CancellationToken): Promise<AggregatedModelInfoResponse> {
        const entries = Array.from(this.clients.entries());
        const results = await Promise.allSettled(
            entries.map(async ([name, client]) => {
                const response = await client.getModelInfo(token);
                return { backendName: name, response };
            })
        );

        const data: AggregatedModelInfoResponse["data"] = [];

        for (const result of results) {
            if (result.status === "rejected") {
                Logger.error(`Backend model discovery failed`, result.reason);
                continue;
            }
            const { backendName, response } = result.value;
            if (!response.data || !Array.isArray(response.data)) {
                Logger.warn(`Backend "${backendName}" returned invalid model data`);
                continue;
            }
            for (const entry of response.data) {
                const originalId = entry.model_info?.key ?? entry.model_name ?? "unknown";
                data.push({
                    ...entry,
                    backendName,
                    namespacedId: createNamespacedModelId(backendName, originalId),
                });
            }
        }

        return { data };
    }

    /**
     * Checks connection to all backends.
     */
    async checkConnectionAll(
        token?: vscode.CancellationToken
    ): Promise<Array<{ backendName: string; latencyMs: number; modelCount: number; error?: string }>> {
        const entries = Array.from(this.clients.entries());
        const results = await Promise.allSettled(
            entries.map(async ([name, client]) => {
                const result = await client.checkConnection(token);
                return { backendName: name, ...result };
            })
        );

        return results.map((result, index) => {
            const backendName = entries[index][0];
            if (result.status === "fulfilled") {
                return {
                    backendName,
                    latencyMs: result.value.latencyMs,
                    modelCount: result.value.modelCount,
                };
            }
            return {
                backendName,
                latencyMs: -1,
                modelCount: 0,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            };
        });
    }

    /**
     * Routes a chat request to the correct backend based on the model ID prefix.
     * Strips the backend prefix from the model ID before sending.
     */
    async chat(
        namespacedModelId: string,
        request: OpenAIChatCompletionRequest,
        mode?: string,
        token?: vscode.CancellationToken,
        modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        const { client, originalModelId } = this.resolveClient(namespacedModelId);

        const routedRequest: OpenAIChatCompletionRequest = {
            ...request,
            model: originalModelId,
        };

        return client.chat(routedRequest, mode, token, modelInfo);
    }

    /**
     * Counts tokens via the correct backend.
     */
    async countTokens(
        namespacedModelId: string,
        request: LiteLLMTokenCounterRequest,
        token?: vscode.CancellationToken
    ): Promise<LiteLLMTokenCounterResponse> {
        const { client, originalModelId } = this.resolveClient(namespacedModelId);

        const routedRequest: LiteLLMTokenCounterRequest = {
            ...request,
            model: originalModelId,
        };

        return client.countTokens(routedRequest, token);
    }

    /**
     * Resolves the correct client and strips the backend prefix from the model ID.
     * Throws if the model ID doesn't match any known backend.
     */
    private resolveClient(namespacedModelId: string): { client: LiteLLMClient; originalModelId: string } {
        const parsed = parseNamespacedModelId(namespacedModelId, this.backendNames);
        if (!parsed) {
            // Fallback: if only one backend, use it without prefix matching
            if (this.clients.size === 1) {
                const [name, client] = this.clients.entries().next().value as [string, LiteLLMClient];
                Logger.warn(`Model "${namespacedModelId}" has no backend prefix, routing to sole backend "${name}"`);
                return { client, originalModelId: namespacedModelId };
            }
            throw new Error(
                `Cannot route model "${namespacedModelId}": no matching backend prefix. ` +
                    `Known backends: ${this.backendNames.join(", ")}`
            );
        }

        const client = this.clients.get(parsed.backendName);
        if (!client) {
            throw new Error(`Backend "${parsed.backendName}" not found in active clients.`);
        }

        return { client, originalModelId: parsed.originalModelId };
    }
}
