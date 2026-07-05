import * as assert from "assert";
import * as vscode from "vscode";
import { Transport } from "../transport";
import type { TransportDeps } from "../types";
import type { ConfigManager } from "../../../config/configManager";
import type { LiteLLMClient } from "../../../adapters/litellmClient";
import type { OpenAIChatCompletionRequest } from "../../../types";

/**
 * A client-like factory that captures the most recent backend params passed to it.
 * The factory reconstructs a new instance each time so the transport's threading
 * of disableCaching is observable.
 */
let lastClientParams: { url: string; key?: string; disableCaching?: boolean } | undefined;

class CachingSpyClient {
    public readonly disableCaching?: boolean;
    public lastEndpoint = "";
    constructor(cfg: { url: string; key?: string; disableCaching?: boolean }, _ua: string) {
        this.disableCaching = cfg.disableCaching;
    }
    async chat(
        _request: OpenAIChatCompletionRequest,
        mode: string | undefined,
        _token?: vscode.CancellationToken
    ): Promise<ReadableStream<Uint8Array>> {
        this.lastEndpoint = mode ?? "chat";
        return new ReadableStream<Uint8Array>({
            start(c) {
                c.close();
            },
        });
    }
}

function makeTransport(): Transport {
    lastClientParams = undefined;
    const deps: TransportDeps = {
        configManager: { getConfig: async () => ({}) } as unknown as ConfigManager,
        userAgent: "test-ua",
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
        liteLLMClientFactory: (backend) => {
            lastClientParams = { url: backend.url, key: backend.key, disableCaching: backend.disableCaching };
            return new CachingSpyClient(backend, "test-ua") as unknown as LiteLLMClient;
        },
    };
    return new Transport(deps);
}

const req: OpenAIChatCompletionRequest = { model: "m", messages: [{ role: "user", content: "x" }], stream: true };

suite("disableCaching wiring", () => {
    test("threads disableCaching=true into the LiteLLMClient", async () => {
        const transport = makeTransport();
        await transport.sendRequestToLiteLLM(
            req,
            { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
            new vscode.CancellationTokenSource().token,
            "chat",
            { mode: "chat" },
            { baseUrl: "https://x", apiKey: "k", disableCaching: true }
        );
        assert.ok(lastClientParams);
        assert.strictEqual(lastClientParams!.disableCaching, true, "client must receive disableCaching=true");
    });

    test("threads disableCaching=false into the LiteLLMClient", async () => {
        const transport = makeTransport();
        await transport.sendRequestToLiteLLM(
            req,
            { report: () => {} } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
            new vscode.CancellationTokenSource().token,
            "chat",
            { mode: "chat" },
            { baseUrl: "https://x", apiKey: "k", disableCaching: false }
        );
        assert.ok(lastClientParams);
        assert.strictEqual(lastClientParams!.disableCaching, false);
    });
});
