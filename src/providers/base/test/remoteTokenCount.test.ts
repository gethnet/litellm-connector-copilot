import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { countRemoteTokens } from "../remoteTokenCount";
import { ConfigManager } from "../../../config/configManager";
import { LiteLLMClient } from "../../../adapters/litellmClient";
import { Logger } from "../../../utils/logger";
import { createMockSecrets } from "../../../test/utils/testMocks";

suite("Remote token-count lifecycle (#180)", () => {
    let sandbox: sinon.SinonSandbox;
    let source: vscode.CancellationTokenSource;
    setup(() => {
        sandbox = sinon.createSandbox();
        source = new vscode.CancellationTokenSource();
    });
    teardown(() => {
        source.dispose();
        sandbox.restore();
        sinon.restore();
    });
    function deps(found = true) {
        const configManager = new ConfigManager(createMockSecrets());
        sandbox.stub(configManager, "getConfig").resolves({});
        return {
            configManager,
            registry: {
                lookup: () => (found ? { baseUrl: "https://counter.example", apiKey: "test-key" } : undefined),
            },
            userAgent: "test",
            getRawModelName: () => "azure_ai/raw",
        };
    }
    test("unknown route does not invoke HTTP or invent global configuration", async () => {
        const counter = sandbox.stub(LiteLLMClient.prototype, "countTokens");
        assert.strictEqual(
            await countRemoteTokens({
                deps: deps(false),
                modelId: "unknown",
                input: "text",
                timeoutMs: 100,
                parentToken: source.token,
            }),
            undefined
        );
        assert.ok(counter.notCalled);
    });
    test("uses full messages and the raw model name", async () => {
        const counter = sandbox.stub(LiteLLMClient.prototype, "countTokens").resolves({ token_count: 42 });
        const messages = [vscode.LanguageModelChatMessage.User("system"), vscode.LanguageModelChatMessage.User("diff")];
        assert.strictEqual(
            await countRemoteTokens({
                deps: deps(),
                modelId: "host/raw",
                input: messages,
                timeoutMs: 100,
                parentToken: source.token,
            }),
            42
        );
        assert.deepStrictEqual(counter.firstCall.args[0], {
            model: "azure_ai/raw",
            messages: [
                { role: "user", content: "system" },
                { role: "user", content: "diff" },
            ],
        });
    });
    test("timeout resolves even when an uncooperative client never settles", async () => {
        const dependencies = deps();
        const clock = sandbox.useFakeTimers();
        const counter = sandbox.stub(LiteLLMClient.prototype, "countTokens").returns(new Promise(() => undefined));
        const pending = countRemoteTokens({
            deps: dependencies,
            modelId: "host/raw",
            input: "text",
            timeoutMs: 100,
            parentToken: source.token,
        });
        await clock.tickAsync(0);
        assert.ok(counter.calledOnce);
        await clock.tickAsync(100);
        assert.strictEqual(await pending, undefined);
        assert.strictEqual(counter.firstCall.args[1]?.isCancellationRequested, true);
        clock.restore();
    });
    test("late success after timeout cannot alter the resolved fallback", async () => {
        const dependencies = deps();
        const clock = sandbox.useFakeTimers();
        let finish!: (value: { token_count: number }) => void;
        sandbox.stub(LiteLLMClient.prototype, "countTokens").returns(
            new Promise<{ token_count: number }>((resolve) => {
                finish = resolve;
            })
        );
        const pending = countRemoteTokens({
            deps: dependencies,
            modelId: "host/raw",
            input: "text",
            timeoutMs: 100,
            parentToken: source.token,
        });
        await clock.tickAsync(100);
        assert.strictEqual(await pending, undefined);
        finish({ token_count: 42 });
        await clock.tickAsync(0);
        assert.strictEqual(await pending, undefined);
        clock.restore();
    });
    test("parent cancellation promptly resolves and propagates to the child", async () => {
        const dependencies = deps();
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const counter = sandbox.stub(LiteLLMClient.prototype, "countTokens").callsFake(() => {
            started();
            return new Promise(() => undefined);
        });
        const pending = countRemoteTokens({
            deps: dependencies,
            modelId: "host/raw",
            input: "text",
            timeoutMs: 3000,
            parentToken: source.token,
        });
        await ready;
        source.cancel();
        assert.strictEqual(await pending, undefined);
        assert.strictEqual(counter.firstCall.args[1]?.isCancellationRequested, true);
    });
    test("rejects invalid count values and handles blocked routes without leaking failure text", async () => {
        const dependencies = deps();
        const counter = sandbox.stub(LiteLLMClient.prototype, "countTokens");
        for (const token_count of [-1, Number.NaN, Infinity]) {
            counter.resolves({ token_count });
            assert.strictEqual(
                await countRemoteTokens({
                    deps: dependencies,
                    modelId: "host/raw",
                    input: "text",
                    timeoutMs: 100,
                }),
                undefined
            );
        }
        counter.rejects(new Error("secret-bearing backend failure"));
        assert.strictEqual(
            await countRemoteTokens({
                deps: dependencies,
                modelId: "host/raw",
                input: "text",
                timeoutMs: 100,
            }),
            undefined
        );
    });
    test("counter HTTP failure logs only status and disposes its cancellation listener", async () => {
        const secret = "private-upstream-api-key-example";
        const error = sandbox.stub(Logger, "error");
        const warn = sandbox.stub(Logger, "warn");
        const response = new Response(secret, { status: 403, statusText: "Forbidden" });
        const fetchStub = sandbox.stub(globalThis, "fetch").resolves(response);
        const listener = new vscode.Disposable(() => undefined);
        const dispose = sandbox.spy(listener, "dispose");
        const token: vscode.CancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => listener,
        };
        const client = new LiteLLMClient({ url: "https://counter.example", key: "test-key" }, "test");
        client.setTelemetryService({
            captureConnectionError: () => undefined,
        } as unknown as import("../../../telemetry/telemetryService").TelemetryService);
        await assert.rejects(() => client.countTokens({ model: "raw", prompt: "diff" }, token), /HTTP 403/);
        assert.ok(fetchStub.calledOnce);
        assert.strictEqual(dispose.callCount, 1);
        assert.ok(error.notCalled);
        assert.ok(warn.calledOnce);
        assert.strictEqual(JSON.stringify(warn.getCalls().map((call) => call.args)).includes(secret), false);
    });
});
