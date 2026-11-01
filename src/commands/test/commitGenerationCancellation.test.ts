import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { registerGenerateCommitMessageCommand } from "../generateCommitMessage";
import { LiteLLMCommitMessageProvider } from "../../providers/liteLLMCommitProvider";
import type { ConfigManager } from "../../config/configManager";
import { GitUtils } from "../../utils/gitUtils";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

suite("Commit generation cancellation", () => {
    let sandbox: sinon.SinonSandbox;
    let provider: sinon.SinonStubbedInstance<LiteLLMCommitMessageProvider>;
    let commands: Map<string, (scm?: unknown) => Promise<void>>;
    let context: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        provider = sandbox.createStubInstance(LiteLLMCommitMessageProvider);
        commands = new Map();
        sandbox.stub(vscode.commands, "registerCommand").callsFake((name, handler) => {
            commands.set(name, handler as (scm?: unknown) => Promise<void>);
            return new vscode.Disposable(() => {});
        });
        context = sandbox.stub(vscode.commands, "executeCommand").resolves();
        sandbox
            .stub(vscode.window, "withProgress")
            .callsFake(async (_options, task) =>
                task({ report: () => {} }, new vscode.CancellationTokenSource().token)
            );
        sandbox.stub(vscode.lm, "selectChatModels").resolves([]);
    });

    teardown(() => sandbox.restore());

    function register(): { generate: (scm?: unknown) => Promise<void>; stop: () => Promise<void> } {
        registerGenerateCommitMessageCommand(provider);
        const generate = commands.get("litellm-connector.generateCommitMessage");
        const stop = commands.get("litellm-connector.stopCommitMessageGeneration");
        assert.ok(generate);
        assert.ok(stop);
        return { generate, stop };
    }

    test("contributes mutually exclusive generate and stop actions", () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../../package.json"), "utf8")) as {
            contributes: {
                commands: { command: string; icon?: string | { light: string; dark: string } }[];
                menus: { "scm/title": { command: string; when: string }[] };
            };
        };
        const items = manifest.contributes.menus["scm/title"];
        const generate = items.find((item) => item.command === "litellm-connector.generateCommitMessage");
        const stops = items.filter((item) => item.command === "litellm-connector.stopCommitMessageGeneration");
        assert.strictEqual(stops.length, 1);
        const stop = stops[0];
        assert.ok(stop);
        assert.ok(generate?.when.includes("!litellm-connector.commitGenerationActive"));
        assert.ok(stop.when.includes("litellm-connector.commitGenerationActive"));
        const icon = manifest.contributes.commands.find((item) => item.command === stop.command)?.icon;
        assert.ok(icon && typeof icon === "object", "the stop command must use a themed icon");
        assert.notStrictEqual(icon.light, icon.dark);
        for (const [theme, expectedColor] of [
            ["light", "#424242"],
            ["dark", "#c5c5c5"],
        ] as const) {
            const svg: string = fs.readFileSync(path.join(__dirname, "../../../..", icon[theme]), "utf8");
            assert.ok(svg.includes('viewBox="0 0 16 16"'));
            assert.ok(svg.includes(expectedColor), `${theme} icon must contrast with its theme`);
            assert.match(svg, /<g[^>]*>[\s\S]*<animateTransform[^>]*type="rotate"[^>]*repeatCount="indefinite"/);
            assert.match(svg, /<\/g>\s*<rect x="6" y="6" width="4" height="4"/);
        }
        const ignore = fs.readFileSync(path.join(__dirname, "../../../../.vscodeignore"), "utf8");
        assert.match(ignore, /^!assets\/\*\*$/m, "the icon assets must be included in packaged extensions");
    });

    test("stops during preparation, blocks another repository until cleanup, and resets context", async () => {
        const config = deferred<{ commitModelIdOverride: string }>();
        provider.getConfigManager.returns({ getConfig: () => config.promise } as unknown as ConfigManager);
        const diff = sandbox.stub(GitUtils, "getStagedDiff").resolves("diff");
        const { generate, stop } = register();
        const first = generate({ rootUri: vscode.Uri.file("/a") });
        await Promise.resolve();
        assert.ok(context.calledWith("setContext", "litellm-connector.commitGenerationActive", true));
        const progress = vscode.window.withProgress as sinon.SinonStub;
        const progressOptions = progress.firstCall.args[0] as vscode.ProgressOptions;
        assert.strictEqual(progressOptions.location, vscode.ProgressLocation.SourceControl);
        await stop();
        await generate({ rootUri: vscode.Uri.file("/b") });
        config.resolve({ commitModelIdOverride: "model" });
        await first;
        assert.ok(diff.notCalled);
        assert.ok(context.calledWith("setContext", "litellm-connector.commitGenerationActive", false));
    });

    test("cancelling a streaming request passes the token and restores the original input without an error", async () => {
        provider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "model" }),
        } as unknown as ConfigManager);
        sandbox.stub(GitUtils, "getStagedDiff").resolves("diff");
        const inputBox = { value: "existing draft", placeholder: "original", enabled: false };
        sandbox.stub(GitUtils, "getGitAPI").resolves({ repositories: [{ inputBox }] } as unknown as never);
        const streamStarted = deferred<void>();
        const finish = deferred<void>();
        let requestToken: vscode.CancellationToken | undefined;
        const sendRequest = sandbox
            .stub()
            .callsFake((_messages: unknown, _options: unknown, token: vscode.CancellationToken) => {
                requestToken = token;
                return Promise.resolve({
                    stream: (async function* () {
                        yield new vscode.LanguageModelTextPart("partial");
                        streamStarted.resolve();
                        await finish.promise;
                        throw new Error("cancelled by provider");
                    })(),
                });
            });
        (vscode.lm.selectChatModels as sinon.SinonStub).resolves([{ maxInputTokens: 8000, sendRequest }]);
        const error = sandbox.stub(vscode.window, "showErrorMessage");
        const { generate, stop } = register();
        const running = generate();
        await streamStarted.promise;
        assert.strictEqual(inputBox.value, "partial");
        await stop();
        assert.strictEqual(requestToken?.isCancellationRequested, true);
        finish.resolve();
        await running;
        assert.deepStrictEqual(inputBox, { value: "existing draft", placeholder: "original", enabled: false });
        assert.ok(error.notCalled);
        assert.ok(context.calledWith("setContext", "litellm-connector.commitGenerationActive", false));
    });

    test("keeps the single-operation lock until the idle context update completes", async () => {
        const idle = deferred<void>();
        const idleStarted = deferred<void>();
        context.callsFake(async (_command: string, _key: string, value: boolean) => {
            if (!value) {
                idleStarted.resolve();
                await idle.promise;
            }
        });
        provider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "model" }),
        } as unknown as ConfigManager);
        const diff = sandbox.stub(GitUtils, "getStagedDiff").resolves("");
        sandbox.stub(vscode.window, "showInformationMessage");
        const { generate } = register();
        const first = generate();
        await idleStarted.promise;
        await generate();
        assert.strictEqual(diff.callCount, 1);
        idle.resolve();
        await first;
        await generate();
        assert.strictEqual(diff.callCount, 2);
    });

    test("stop cancels the remote recount before it reaches the SCM input or model", async () => {
        provider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "model" }),
        } as unknown as ConfigManager);
        sandbox.stub(GitUtils, "getStagedDiff").resolves("diff");
        const getGitAPI = sandbox.stub(GitUtils, "getGitAPI");
        const started = deferred<vscode.CancellationToken | undefined>();
        const finished = deferred<number | undefined>();
        provider.remoteCountTokens.callsFake((_model, _text, _timeout, token) => {
            started.resolve(token);
            token?.onCancellationRequested(() => finished.resolve(undefined));
            return finished.promise;
        });
        const { generate, stop } = register();
        const running = generate();
        const recountToken = await started.promise;
        await stop();
        try {
            assert.ok(recountToken, "the SCM cancellation token must reach the remote recount");
            assert.strictEqual(recountToken.isCancellationRequested, true);
        } finally {
            finished.resolve(undefined);
            await running;
        }
        assert.ok(getGitAPI.notCalled);
        assert.ok(context.calledWith("setContext", "litellm-connector.commitGenerationActive", false));
    });

    for (const scenario of ["stream failure", "empty response", "whitespace response", "missing model"] as const) {
        test(`restores the original draft after ${scenario}`, async () => {
            provider.getConfigManager.returns({
                getConfig: async () => ({ commitModelIdOverride: "model" }),
            } as unknown as ConfigManager);
            sandbox.stub(GitUtils, "getStagedDiff").resolves("diff");
            const inputBox = { value: "existing draft", placeholder: "original", enabled: false };
            sandbox.stub(GitUtils, "getGitAPI").resolves({ repositories: [{ inputBox }] } as unknown as never);
            if (scenario !== "missing model") {
                const sendRequest = sandbox.stub().resolves({
                    stream: (async function* () {
                        if (scenario === "stream failure") {
                            yield new vscode.LanguageModelTextPart("partial");
                            throw new Error("stream failed");
                        }
                        if (scenario === "whitespace response") {
                            yield new vscode.LanguageModelTextPart("   ");
                        }
                    })(),
                });
                (vscode.lm.selectChatModels as sinon.SinonStub).resolves([{ maxInputTokens: 8000, sendRequest }]);
            }
            const error = sandbox.stub(vscode.window, "showErrorMessage");
            const { generate } = register();
            await generate();
            assert.deepStrictEqual(inputBox, { value: "existing draft", placeholder: "original", enabled: false });
            assert.ok(error.calledOnce);
        });
    }

    test("replaces the original draft after successful generation", async () => {
        provider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "model" }),
        } as unknown as ConfigManager);
        sandbox.stub(GitUtils, "getStagedDiff").resolves("diff");
        const inputBox = { value: "existing draft", placeholder: "original", enabled: false };
        sandbox.stub(GitUtils, "getGitAPI").resolves({ repositories: [{ inputBox }] } as unknown as never);
        const sendRequest = sandbox.stub().resolves({
            stream: (async function* () {
                yield new vscode.LanguageModelTextPart("fix: message");
            })(),
        });
        (vscode.lm.selectChatModels as sinon.SinonStub).resolves([{ maxInputTokens: 8000, sendRequest }]);
        const { generate } = register();
        await generate();
        assert.deepStrictEqual(inputBox, { value: "fix: message", placeholder: "original", enabled: false });
    });

    test("restores the draft when a cancelled stream ends normally", async () => {
        provider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "model" }),
        } as unknown as ConfigManager);
        sandbox.stub(GitUtils, "getStagedDiff").resolves("diff");
        const inputBox = { value: "draft", placeholder: "placeholder", enabled: true };
        sandbox.stub(GitUtils, "getGitAPI").resolves({ repositories: [{ inputBox }] } as unknown as never);
        const started = deferred<void>();
        const finish = deferred<void>();
        const sendRequest = sandbox.stub().resolves({
            stream: (async function* () {
                yield new vscode.LanguageModelTextPart("partial");
                started.resolve();
                await finish.promise;
            })(),
        });
        (vscode.lm.selectChatModels as sinon.SinonStub).resolves([{ maxInputTokens: 8000, sendRequest }]);
        const error = sandbox.stub(vscode.window, "showErrorMessage");
        const { generate, stop } = register();
        const running = generate();
        await started.promise;
        await stop();
        finish.resolve();
        await running;
        assert.deepStrictEqual(inputBox, { value: "draft", placeholder: "placeholder", enabled: true });
        assert.ok(error.notCalled);
    });

    test("resets context when progress setup fails and allows a later operation", async () => {
        (vscode.window.withProgress as sinon.SinonStub).onFirstCall().rejects(new Error("progress unavailable"));
        provider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "model" }),
        } as unknown as ConfigManager);
        sandbox.stub(GitUtils, "getStagedDiff").resolves("");
        sandbox.stub(vscode.window, "showInformationMessage");
        const { generate } = register();
        await assert.rejects(generate(), /progress unavailable/);
        assert.ok(context.calledWith("setContext", "litellm-connector.commitGenerationActive", false));
        await generate();
        assert.strictEqual((vscode.window.withProgress as sinon.SinonStub).callCount, 2);
    });

    test("does not update a different repository when the requested SCM repository disappears", async () => {
        provider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "model" }),
        } as unknown as ConfigManager);
        sandbox.stub(GitUtils, "getStagedDiff").resolves("diff");
        const inputBox = { value: "other repository", placeholder: "", enabled: true };
        sandbox
            .stub(GitUtils, "getGitAPI")
            .resolves({ repositories: [{ rootUri: vscode.Uri.file("/other"), inputBox }] } as unknown as never);
        const sendRequest = sandbox.stub();
        (vscode.lm.selectChatModels as sinon.SinonStub).resolves([{ maxInputTokens: 8000, sendRequest }]);
        const { generate } = register();
        await generate({ rootUri: vscode.Uri.file("/missing") });
        assert.strictEqual(inputBox.value, "other repository");
        assert.ok(sendRequest.notCalled);
    });
});
