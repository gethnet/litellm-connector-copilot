import * as assert from "assert";
import * as vscode from "vscode";
import { Transport } from "../transport";
import type { TransportDeps } from "../types";
import type { ConfigManager } from "../../../config/configManager";
import type { LiteLLMClient } from "../../../adapters/litellmClient";
import type { OpenAIChatCompletionRequest, LiteLLMModelInfo } from "../../../types";

// Test seam: a fake LiteLLMClient that records the `mode` passed to chat()
// and can be programmed to fail the first call with a 500-shaped error.
class FakeLiteLLMClient {
    public calls: string[] = [];
    public failFirstResponsesWith500 = false;
    public firstCallFailed = false;
    public readonly disableCaching?: boolean;

    constructor(
        private readonly cfg: { url: string; key?: string; disableCaching?: boolean },
        _ua: string
    ) {
        this.disableCaching = cfg.disableCaching;
    }

    async chat(
        _request: OpenAIChatCompletionRequest,
        mode: string | undefined,
        _token?: vscode.CancellationToken,
        _modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        this.calls.push(mode ?? "undefined");
        if (this.failFirstResponsesWith500 && !this.firstCallFailed && mode === "responses") {
            this.firstCallFailed = true;
            throw new Error(
                "LiteLLM API error: 500 Internal Server Error\n" +
                    '{"error":{"message":"ResponsesAPIResponse validation errors"}}'
            );
        }
        // Return an empty, immediately-closed stream as success.
        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        });
    }
}

function makeDeps(fake: FakeLiteLLMClient): TransportDeps {
    return {
        configManager: { getConfig: async () => ({}) } as unknown as ConfigManager,
        userAgent: "test-ua",
        logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {},
        },
        liteLLMClientFactory: (backend) => {
            // Re-bind the same fake instance so calls are recorded across retries.
            Object.assign(fake, { __backend: backend });
            return fake as unknown as LiteLLMClient;
        },
    };
}

const baseRequest: OpenAIChatCompletionRequest = {
    model: "azure_ai/gpt-5.4-mini",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
};

const responsesModelInfo: LiteLLMModelInfo = { mode: "responses" };
const chatModelInfo: LiteLLMModelInfo = { mode: "chat" };

suite("Transport /responses -> /chat/completions fallback", () => {
    test("falls back to chat when /responses returns 500 and flag is set", async () => {
        const fake = new FakeLiteLLMClient({ url: "https://x", key: "k" }, "test-ua");
        fake.failFirstResponsesWith500 = true;
        const transport = new Transport(makeDeps(fake));

        const stream = await transport.sendRequestToLiteLLM(
            baseRequest,
            { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
            new vscode.CancellationTokenSource().token,
            "tools",
            responsesModelInfo,
            { baseUrl: "https://x", apiKey: "k", allowChatCompletionsFallback: true }
        );
        void stream; // stream is consumed by the caller; we only assert routing here
        assert.deepStrictEqual(fake.calls, ["responses", "chat"]);
    });

    test("does NOT fall back when flag is absent (preserves hard-failure semantics)", async () => {
        const fake = new FakeLiteLLMClient({ url: "https://x", key: "k" }, "test-ua");
        fake.failFirstResponsesWith500 = true;
        const transport = new Transport(makeDeps(fake));

        await assert.rejects(
            () =>
                transport.sendRequestToLiteLLM(
                    baseRequest,
                    { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
                    new vscode.CancellationTokenSource().token,
                    "tools",
                    responsesModelInfo,
                    { baseUrl: "https://x", apiKey: "k" } // no allowChatCompletionsFallback
                ),
            /LiteLLM API error: 500/
        );
        assert.deepStrictEqual(fake.calls, ["responses"]);
    });

    test("does NOT fall back when mode is already chat (no responses to escape)", async () => {
        const fake = new FakeLiteLLMClient({ url: "https://x", key: "k" }, "test-ua");
        fake.failFirstResponsesWith500 = true; // irrelevant for chat mode
        const transport = new Transport(makeDeps(fake));

        const stream = await transport.sendRequestToLiteLLM(
            baseRequest,
            { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
            new vscode.CancellationTokenSource().token,
            "tools",
            chatModelInfo,
            { baseUrl: "https://x", apiKey: "k", allowChatCompletionsFallback: true }
        );
        void stream;
        assert.deepStrictEqual(fake.calls, ["chat"]);
    });

    test("does NOT fall back on 4xx (only 5xx from /responses triggers fallback)", async () => {
        const fake = new FakeLiteLLMClient({ url: "https://x", key: "k" }, "test-ua");
        // Program a 400 by overriding chat()
        fake.chat = async function (this: FakeLiteLLMClient, _req: OpenAIChatCompletionRequest, mode?: string) {
            this.calls.push(mode ?? "undefined");
            throw new Error("LiteLLM API error: 400 Bad Request\nunsupported parameter");
        };
        const transport = new Transport(makeDeps(fake));

        await assert.rejects(
            () =>
                transport.sendRequestToLiteLLM(
                    baseRequest,
                    { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
                    new vscode.CancellationTokenSource().token,
                    "tools",
                    responsesModelInfo,
                    { baseUrl: "https://x", apiKey: "k", allowChatCompletionsFallback: true }
                ),
            /400 Bad Request/
        );
        assert.deepStrictEqual(fake.calls, ["responses"]);
    });
});
