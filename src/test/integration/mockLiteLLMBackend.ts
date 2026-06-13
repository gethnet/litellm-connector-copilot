/**
 * Mock LiteLLM Backend Server for Memory Profiling Tests
 *
 * This mock server simulates a fully functional LiteLLM proxy supporting:
 * - /chat/completions (streaming + non-streaming)
 * - /models (model discovery)
 * - Token counting
 * - Reasoning effort support
 * - Tool calls and error handling
 *
 * Usage:
 *   const backend = new MockLiteLLMBackend(4000);
 *   await backend.start();
 *   // Run tests
 *   await backend.stop();
 */

import * as http from "http";
import * as url from "url";

export interface MockBackendOptions {
    port: number;
    latencyMs?: number;
    toolCallSupport?: boolean;
    reasoningSupport?: boolean;
}

export class MockLiteLLMBackend {
    private server: http.Server | null = null;
    private port: number;
    private latencyMs: number;
    private toolCallSupport: boolean;
    private reasoningSupport: boolean;
    private requestCount = 0;

    constructor(options: MockBackendOptions) {
        this.port = options.port;
        this.latencyMs = options.latencyMs ?? 50;
        this.toolCallSupport = options.toolCallSupport ?? true;
        this.reasoningSupport = options.reasoningSupport ?? true;
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this.handleRequest(req, res));

            this.server.on("error", (err) => {
                reject(err);
            });

            this.server.listen(this.port, () => {
                console.log(`[MockLiteLLM] Server listening on port ${this.port}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.server) {
                resolve();
                return;
            }
            this.server.close((err) => {
                if (err) {
                    reject(err);
                } else {
                    console.log(`[MockLiteLLM] Server stopped`);
                    resolve();
                }
            });
        });
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const parsedUrl = url.parse(req.url || "", true);
        const pathname = parsedUrl.pathname || "";

        // Log incoming request
        this.requestCount++;
        console.log(`[MockLiteLLM] Request #${this.requestCount}: ${req.method} ${pathname}`);

        try {
            // Add artificial latency to simulate network
            if (this.latencyMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
            }

            switch (pathname) {
                case "/models":
                    this.handleModels(res);
                    break;

                case "/chat/completions":
                    if (req.method === "POST") {
                        await this.handleChatCompletions(req, res);
                    } else {
                        this.sendError(res, 405, "Method not allowed");
                    }
                    break;

                case "/token_count":
                    if (req.method === "POST") {
                        await this.handleTokenCount(req, res);
                    } else {
                        this.sendError(res, 405, "Method not allowed");
                    }
                    break;

                case "/responses":
                    if (req.method === "POST") {
                        await this.handleResponses(req, res);
                    } else {
                        this.sendError(res, 405, "Method not allowed");
                    }
                    break;

                default:
                    this.sendError(res, 404, `Not found: ${pathname}`);
                    break;
            }
        } catch (err) {
            console.error(`[MockLiteLLM] Error handling request:`, err);
            this.sendError(res, 500, "Internal server error");
        }
    }

    private handleModels(res: http.ServerResponse): void {
        const models = {
            data: [
                {
                    id: "gpt-4o",
                    object: "model",
                    owned_by: "openai",
                    permission: [],
                },
                {
                    id: "gpt-4-turbo",
                    object: "model",
                    owned_by: "openai",
                    permission: [],
                },
                {
                    id: "claude-3-opus",
                    object: "model",
                    owned_by: "anthropic",
                    permission: [],
                },
                {
                    id: "claude-3-sonnet",
                    object: "model",
                    owned_by: "anthropic",
                    permission: [],
                },
            ],
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(models));
    }

    private async handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await this.readBody(req);
        const request = JSON.parse(body) as Record<string, unknown>;

        // Simulate tool call if requested
        if (this.toolCallSupport && Math.random() > 0.7) {
            this.sendToolCallResponse(res, request);
            return;
        }

        // Default text response
        if (request.stream === true) {
            this.sendStreamingResponse(res, request);
        } else {
            this.sendNonStreamingResponse(res, request);
        }
    }

    private async handleTokenCount(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await this.readBody(req);
        const request = JSON.parse(body) as Record<string, unknown>;

        // Estimate token count: roughly 1 token per 4 characters
        let tokenCount = 0;

        if (typeof request.prompt === "string") {
            tokenCount = Math.ceil(request.prompt.length / 4);
        } else if (Array.isArray(request.messages)) {
            for (const msg of request.messages) {
                if (typeof msg === "object" && msg !== null) {
                    const content = (msg as Record<string, unknown>).content;
                    if (typeof content === "string") {
                        tokenCount += Math.ceil(content.length / 4);
                    }
                }
            }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                token_count: Math.max(10, tokenCount),
            })
        );
    }

    private async handleResponses(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // Streaming /responses endpoint (SSE format)
        const body = await this.readBody(req);
        const request = JSON.parse(body) as Record<string, unknown>;

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        // Send model info
        res.write(`data: ${JSON.stringify({ type: "session.created" })}\n\n`);

        // Send output text
        const responseText = `This is a mock response to: ${(request as Record<string, unknown>).model}`;
        for (let i = 0; i < responseText.length; i += 5) {
            const chunk = responseText.substring(i, i + 5);
            res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: chunk })}\n\n`);
            // Simulate streaming delay
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // Send completion
        res.write(
            `data: ${JSON.stringify({
                type: "response.completed",
                response: { usage: { input_tokens: 50, output_tokens: 30 } },
            })}\n\n`
        );

        res.end();
    }

    private sendStreamingResponse(res: http.ServerResponse, request: Record<string, unknown>): void {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        // Generate a response based on model
        const model = String(request.model ?? "gpt-4o");
        const responseText = this.generateResponse(model);

        // Stream response in chunks
        let sentChunks = 0;
        const chunkSize = 20;

        const sendChunk = (): void => {
            const start = sentChunks * chunkSize;
            const end = start + chunkSize;
            const chunk = responseText.substring(start, end);

            if (chunk.length === 0) {
                // Send final delta with usage
                res.write(
                    `data: ${JSON.stringify({
                        choices: [
                            {
                                delta: { content: null },
                                finish_reason: "stop",
                            },
                        ],
                        usage: {
                            prompt_tokens: 10,
                            completion_tokens: Math.ceil(responseText.length / 4),
                        },
                    })}\n\n`
                );
                res.end();
                return;
            }

            res.write(
                `data: ${JSON.stringify({
                    choices: [
                        {
                            delta: { content: chunk },
                            finish_reason: null,
                        },
                    ],
                })}\n\n`
            );

            sentChunks++;
            setTimeout(sendChunk, 10);
        };

        sendChunk();
    }

    private sendNonStreamingResponse(res: http.ServerResponse, request: Record<string, unknown>): void {
        const model = String(request.model ?? "gpt-4o");
        const responseText = this.generateResponse(model);

        const response = {
            choices: [
                {
                    message: {
                        content: responseText,
                        role: "assistant",
                    },
                    finish_reason: "stop",
                },
            ],
            usage: {
                prompt_tokens: 10,
                completion_tokens: Math.ceil(responseText.length / 4),
            },
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
    }

    private sendToolCallResponse(res: http.ServerResponse, request: Record<string, unknown>): void {
        const model = String(request.model ?? "gpt-4o");

        if (request.stream === true) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });

            // Send tool call in streaming format
            res.write(
                `data: ${JSON.stringify({
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        id: "call_123",
                                        type: "function",
                                        function: {
                                            name: "replace_string_in_file",
                                            arguments: '{"filePath":"test.ts","oldString":"old","newString":"new"}',
                                        },
                                    },
                                ],
                            },
                            finish_reason: null,
                        },
                    ],
                })}\n\n`
            );

            res.write(
                `data: ${JSON.stringify({
                    choices: [{ delta: { tool_calls: [] }, finish_reason: "tool_calls" }],
                })}\n\n`
            );

            res.end();
        } else {
            const response = {
                choices: [
                    {
                        message: {
                            role: "assistant",
                            tool_calls: [
                                {
                                    id: "call_123",
                                    type: "function",
                                    function: {
                                        name: "replace_string_in_file",
                                        arguments: '{"filePath":"test.ts","oldString":"old","newString":"new"}',
                                    },
                                },
                            ],
                        },
                        finish_reason: "tool_calls",
                    },
                ],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 50,
                },
            };

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
        }
    }

    private generateResponse(model: string): string {
        const responses: Record<string, string> = {
            "gpt-4o": "This is a response from GPT-4o. It demonstrates the model's capabilities.",
            "gpt-4-turbo": "Response from GPT-4 Turbo. Fast and efficient.",
            "claude-3-opus": "This is Claude 3 Opus speaking. I can help with complex tasks.",
            "claude-3-sonnet": "Claude 3 Sonnet here. Ready to assist.",
        };

        return responses[model] || `Response from ${model}.`;
    }

    private sendError(res: http.ServerResponse, statusCode: number, message: string): void {
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                error: {
                    message,
                    type: "invalid_request_error",
                    code: statusCode,
                },
            })
        );
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = "";
            req.on("data", (chunk: Buffer) => {
                body += chunk.toString("utf8");
            });
            req.on("end", () => {
                resolve(body);
            });
            req.on("error", (err) => {
                reject(err);
            });
        });
    }

    getBaseUrl(): string {
        return `http://localhost:${this.port}`;
    }

    getRequestCount(): number {
        return this.requestCount;
    }
}

export default MockLiteLLMBackend;
