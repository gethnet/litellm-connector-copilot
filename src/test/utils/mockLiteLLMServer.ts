import * as http from "http";
import { EventEmitter } from "events";

/**
 * Configuration for mock LiteLLM server responses.
 */
export interface MockServerConfig {
    port: number;
    responses?: {
        chat?: {
            stream?: boolean;
            body?: Record<string, unknown>;
            error?: { status: number; body: Record<string, unknown> };
            latency?: number;
        };
        responses?: {
            stream?: boolean;
            body?: Record<string, unknown>;
            error?: { status: number; body: Record<string, unknown> };
            latency?: number;
        };
    };
    modelList?: {
        data: {
            id: string;
            object: string;
            created: number;
            model: string;
        }[];
    };
}

/**
 * Represents a logged request to the mock server.
 */
export interface PendingRequest {
    method: string;
    path: string;
    body?: string;
    timestamp: number;
}

/**
 * Lightweight mock LiteLLM server for testing.
 * Supports `/v1/chat/completions`, `/v1/completions`, `/v1/models`, and `/responses` endpoints.
 *
 * This server is used for integration testing of the provider layer without
 * requiring a real LiteLLM backend. It logs all requests and can be configured
 * to return specific responses or errors.
 *
 * @example
 * ```typescript
 * const server = new MockLiteLLMServer({ port: 49999 });
 * await server.start();
 *
 * // Make requests to http://localhost:49999/v1/chat/completions
 * const requests = server.getRequests();
 *
 * await server.stop();
 * ```
 */
export class MockLiteLLMServer extends EventEmitter {
    private server: http.Server | null = null;
    private config: MockServerConfig;
    private requestLog: PendingRequest[] = [];
    private _isRunning = false;

    constructor(config: MockServerConfig) {
        super();
        this.config = config;
    }

    /**
     * Returns whether the server is currently running.
     */
    get isRunning(): boolean {
        return this._isRunning;
    }

    /**
     * Returns a copy of the logged requests.
     */
    getRequests(): PendingRequest[] {
        return [...this.requestLog];
    }

    /**
     * Clears the request log.
     */
    clearRequests(): void {
        this.requestLog = [];
    }

    /**
     * Starts the mock server.
     * @returns Promise that resolves when the server is listening
     */
    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(this.handleRequest.bind(this));
            this.server.on("error", (err) => {
                this.emit("error", err);
                reject(err);
            });
            this.server.listen(this.config.port, () => {
                this._isRunning = true;
                this.emit("start");
                resolve();
            });
        });
    }

    /**
     * Stops the mock server.
     * @returns Promise that resolves when the server is closed
     */
    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this._isRunning = false;
                    this.emit("stop");
                    resolve();
                });
                this.server = null;
            } else {
                resolve();
            }
        });
    }

    /**
     * Main request handler that routes to appropriate endpoint handlers.
     */
    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await this.readBody(req);
        this.requestLog.push({
            method: req.method ?? "GET",
            path: req.url ?? "/",
            body,
            timestamp: Date.now(),
        });

        const path = req.url?.split("?")[0] ?? "/";

        // Handle CORS preflight
        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            });
            res.end();
            return;
        }

        // Route to appropriate handler
        try {
            if (path === "/v1/models" || path === "/models") {
                await this.handleModelList(req, res);
            } else if (path === "/v1/chat/completions") {
                await this.handleChatCompletions(req, res, body);
            } else if (path === "/v1/completions") {
                await this.handleCompletions(req, res, body);
            } else if (path === "/responses") {
                await this.handleResponses(req, res, body);
            } else {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Not found" }));
            }
        } catch {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
        }
    }

    /**
     * Reads the request body as a string.
     */
    private async readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve) => {
            let body = "";
            req.on("data", (chunk: Buffer | string) => (body += chunk.toString()));
            req.on("end", () => resolve(body));
        });
    }

    /**
     * Handles GET /v1/models requests.
     */
    private async handleModelList(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const response = this.config.modelList ?? {
            data: [{ id: "gpt-4o", object: "model", created: 1234567890, model: "gpt-4o" }],
        };
        this.sendJson(res, 200, response);
    }

    /**
     * Handles POST /v1/chat/completions requests.
     */
    private async handleChatCompletions(
        _req: http.IncomingMessage,
        res: http.ServerResponse,
        body: string
    ): Promise<void> {
        const config = this.config.responses?.chat;

        // Return error if configured
        if (config?.error) {
            this.sendJson(res, config.error.status, config.error.body);
            return;
        }

        // Simulate latency if configured
        if (config?.latency) {
            await new Promise((resolve) => setTimeout(resolve, config.latency));
        }

        const parsed = body ? this.safeParseJson(body) : {};
        const isStream = (parsed?.stream as boolean) ?? config?.stream ?? false;

        if (isStream) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            const model = (parsed?.model as string) ?? "gpt-4o";
            const streamData = [
                `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1234567890,"model":"${model}","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`,
                `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1234567890,"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
                "data: [DONE]",
            ];
            for (const line of streamData) {
                res.write(line + "\n\n");
            }
            res.end();
        } else {
            const model = (parsed?.model as string) ?? "gpt-4o";
            this.sendJson(
                res,
                200,
                config?.body ?? {
                    id: "chatcmpl-test",
                    object: "chat.completion",
                    created: Date.now(),
                    model,
                    choices: [
                        {
                            index: 0,
                            message: { role: "assistant", content: "Test response" },
                            finish_reason: "stop",
                        },
                    ],
                }
            );
        }
    }

    /**
     * Handles POST /responses requests (OpenAI Responses API).
     */
    private async handleResponses(_req: http.IncomingMessage, res: http.ServerResponse, body: string): Promise<void> {
        const config = this.config.responses?.responses;

        // Return error if configured
        if (config?.error) {
            this.sendJson(res, config.error.status, config.error.body);
            return;
        }

        // Simulate latency if configured
        if (config?.latency) {
            await new Promise((resolve) => setTimeout(resolve, config.latency));
        }

        const parsed = body ? this.safeParseJson(body) : {};
        const isStream = (parsed?.stream as boolean) ?? config?.stream ?? false;

        if (isStream) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            const streamData = [
                'data: {"type":"response.output_text.delta","delta":"Hello"}',
                'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
                "data: [DONE]",
            ];
            for (const line of streamData) {
                res.write(line + "\n\n");
            }
            res.end();
        } else {
            const model = (parsed?.model as string) ?? "gpt-4o";
            this.sendJson(
                res,
                200,
                config?.body ?? {
                    id: "resp-test",
                    object: "response",
                    created: Date.now(),
                    model,
                    output: [
                        {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "Test response" }],
                        },
                    ],
                }
            );
        }
    }

    /**
     * Handles POST /v1/completions requests.
     */
    private async handleCompletions(_req: http.IncomingMessage, res: http.ServerResponse, body: string): Promise<void> {
        const config = this.config.responses?.chat;

        // Return error if configured
        if (config?.error) {
            this.sendJson(res, config.error.status, config.error.body);
            return;
        }

        const parsed = body ? this.safeParseJson(body) : {};
        const isStream = (parsed?.stream as boolean) ?? false;

        if (isStream) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            const model = (parsed?.model as string) ?? "gpt-4o";
            const streamData = [
                `data: {"id":"cmpl-test","object":"text_completion","created":1234567890,"model":"${model}","choices":[{"text":"Hello","index":0,"finish_reason":"stop"}]}`,
                "data: [DONE]",
            ];
            for (const line of streamData) {
                res.write(line + "\n\n");
            }
            res.end();
        } else {
            const model = (parsed?.model as string) ?? "gpt-4o";
            this.sendJson(res, 200, {
                id: "cmpl-test",
                object: "text_completion",
                created: Date.now(),
                model,
                choices: [
                    {
                        text: "Test completion",
                        index: 0,
                        finish_reason: "stop",
                    },
                ],
            });
        }
    }

    /**
     * Sends a JSON response.
     */
    private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
        const json = JSON.stringify(body);
        res.writeHead(status, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Content-Length": Buffer.byteLength(json),
        });
        res.end(json);
    }

    /**
     * Safely parses JSON, returning undefined on error.
     */
    private safeParseJson(text: string): Record<string, unknown> | undefined {
        try {
            return JSON.parse(text) as Record<string, unknown>;
        } catch {
            return undefined;
        }
    }
}

/**
 * Creates a default mock server config with standard test models.
 */
export function createDefaultMockConfig(port = 49999): MockServerConfig {
    return {
        port,
        modelList: {
            data: [
                { id: "gpt-4o", object: "model", created: 1234567890, model: "gpt-4o" },
                { id: "gpt-4o-mini", object: "model", created: 1234567890, model: "gpt-4o-mini" },
                { id: "o1-preview", object: "model", created: 1234567890, model: "o1-preview" },
            ],
        },
        responses: {
            chat: {
                body: {
                    id: "chatcmpl-test",
                    object: "chat.completion",
                    created: Date.now(),
                    model: "gpt-4o",
                    choices: [
                        {
                            index: 0,
                            message: { role: "assistant", content: "Test response" },
                            finish_reason: "stop",
                        },
                    ],
                },
            },
        },
    };
}
