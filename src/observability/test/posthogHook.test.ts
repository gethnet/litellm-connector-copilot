import * as assert from "assert";
import * as sinon from "sinon";
import { PostHogHook } from "../posthogHook";
import { HookSystem } from "../hookSystem";
import type { TelemetryService } from "../../telemetry/telemetryService";
import type { HookContext } from "../types";

suite("PostHogHook", () => {
    let sandbox: sinon.SinonSandbox;
    let telemetryMock: sinon.SinonStubbedInstance<TelemetryService>;
    let registerStub: sinon.SinonStub;
    let capturedHandler: ((point: string, ctx: HookContext) => void | Promise<void>) | undefined;
    let capturedDisposable: { dispose: sinon.SinonStub };

    function createPostHogHook(): PostHogHook {
        return new PostHogHook(telemetryMock as unknown as TelemetryService);
    }

    function createContext(overrides: Partial<HookContext> = {}): HookContext {
        return {
            requestId: "req-1",
            modelId: "gpt-4",
            endpoint: "/chat/completions",
            caller: "chat",
            metadata: {},
            ...overrides,
        };
    }

    setup(() => {
        sandbox = sinon.createSandbox();

        telemetryMock = {
            captureRequestCompleted: sandbox.stub(),
            captureRequestFailed: sandbox.stub(),
            captureTrimExecuted: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<TelemetryService>;

        capturedDisposable = { dispose: sandbox.stub() };
        registerStub = sandbox.stub(HookSystem, "register").returns(capturedDisposable);

        // Capture the handler when initialize() is called
        capturedHandler = undefined;
        registerStub.callsFake((_point: string, handler: (point: string, ctx: HookContext) => void | Promise<void>) => {
            capturedHandler = handler;
            return capturedDisposable;
        });
    });

    teardown(() => {
        sandbox.restore();
    });

    suite("initialize", () => {
        test("registers handler on after:transform hook point", () => {
            const hook = createPostHogHook();
            hook.initialize();

            assert.ok(registerStub.calledOnce, "HookSystem.register should be called once");
            assert.strictEqual(registerStub.firstCall.args[0], "after:transform");
            assert.strictEqual(typeof registerStub.firstCall.args[1], "function");
        });

        test("stores the disposable returned by register", () => {
            const hook = createPostHogHook();
            hook.initialize();

            // dispose() should call all stored disposables
            hook.dispose();
            assert.ok(capturedDisposable.dispose.calledOnce);
        });
    });

    suite("handleAfterTransform — success path", () => {
        let hook: PostHogHook;

        setup(() => {
            hook = createPostHogHook();
            hook.initialize();
        });

        test("calls captureRequestCompleted when status is 'success'", async () => {
            const context = createContext({
                metadata: {
                    status: "success",
                    durationMs: 150,
                    tokensIn: 100,
                    tokensOut: 50,
                },
            });

            await capturedHandler!("after:transform", context);

            assert.ok(telemetryMock.captureRequestCompleted.calledOnce);
            const args = telemetryMock.captureRequestCompleted.firstCall.args[0];
            assert.strictEqual(args.request_id, "req-1");
            assert.strictEqual(args.caller, "chat");
            assert.strictEqual(args.model, "gpt-4");
            assert.strictEqual(args.endpoint, "/chat/completions");
            assert.strictEqual(args.durationMs, 150);
            assert.strictEqual(args.tokensIn, 100);
            assert.strictEqual(args.tokensOut, 50);
        });

        test("calls captureRequestCompleted when tokensOut is defined (even without status)", async () => {
            const context = createContext({
                metadata: {
                    tokensOut: 42,
                    durationMs: 200,
                    tokensIn: 80,
                },
            });

            await capturedHandler!("after:transform", context);

            assert.ok(telemetryMock.captureRequestCompleted.calledOnce);
            const args = telemetryMock.captureRequestCompleted.firstCall.args[0];
            assert.strictEqual(args.tokensOut, 42);
        });

        test("defaults token/duration values to 0 when metadata is missing", async () => {
            const context = createContext({
                metadata: { status: "success" },
            });

            await capturedHandler!("after:transform", context);

            const args = telemetryMock.captureRequestCompleted.firstCall.args[0];
            assert.strictEqual(args.durationMs, 0);
            assert.strictEqual(args.tokensIn, 0);
            assert.strictEqual(args.tokensOut, 0);
        });
    });

    suite("handleAfterTransform — error path", () => {
        let hook: PostHogHook;

        setup(() => {
            hook = createPostHogHook();
            hook.initialize();
        });

        test("calls captureRequestFailed when metadata has an error", async () => {
            const context = createContext({
                metadata: {
                    error: "RateLimitExceeded",
                    durationMs: 300,
                },
            });

            await capturedHandler!("after:transform", context);

            assert.ok(telemetryMock.captureRequestFailed.calledOnce);
            assert.ok(telemetryMock.captureRequestCompleted.notCalled);
            const args = telemetryMock.captureRequestFailed.firstCall.args[0];
            assert.strictEqual(args.request_id, "req-1");
            assert.strictEqual(args.caller, "chat");
            assert.strictEqual(args.model, "gpt-4");
            assert.strictEqual(args.endpoint, "/chat/completions");
            assert.strictEqual(args.durationMs, 300);
            assert.strictEqual(args.errorType, "RateLimitExceeded");
        });

        test("does not call captureRequestFailed when status is success and no error", async () => {
            const context = createContext({
                metadata: { status: "success" },
            });

            await capturedHandler!("after:transform", context);

            assert.ok(telemetryMock.captureRequestFailed.notCalled);
        });
    });

    suite("handleAfterTransform — trim tracking", () => {
        let hook: PostHogHook;

        setup(() => {
            hook = createPostHogHook();
            hook.initialize();
        });

        test("calls captureTrimExecuted when trimExecuted is true", async () => {
            const context = createContext({
                metadata: {
                    status: "success",
                    trimExecuted: true,
                    originalTokens: 5000,
                    trimmedTokens: 3000,
                    budget: 4096,
                },
            });

            await capturedHandler!("after:transform", context);

            assert.ok(telemetryMock.captureTrimExecuted.calledOnce);
            const args = telemetryMock.captureTrimExecuted.firstCall.args;
            assert.strictEqual(args[0], "gpt-4");
            assert.strictEqual(args[1], "chat");
            assert.strictEqual(args[2], 5000);
            assert.strictEqual(args[3], 3000);
            assert.strictEqual(args[4], 4096);
        });

        test("does not call captureTrimExecuted when trimExecuted is false", async () => {
            const context = createContext({
                metadata: {
                    status: "success",
                    trimExecuted: false,
                },
            });

            await capturedHandler!("after:transform", context);

            assert.ok(telemetryMock.captureTrimExecuted.notCalled);
        });

        test("defaults trim token values to 0 when metadata is missing", async () => {
            const context = createContext({
                metadata: {
                    status: "success",
                    trimExecuted: true,
                },
            });

            await capturedHandler!("after:transform", context);

            const args = telemetryMock.captureTrimExecuted.firstCall.args;
            assert.strictEqual(args[2], 0); // originalTokens
            assert.strictEqual(args[3], 0); // trimmedTokens
            assert.strictEqual(args[4], 0); // budget
        });

        test("trim tracking is independent of success/error path", async () => {
            const context = createContext({
                metadata: {
                    error: "some error",
                    trimExecuted: true,
                    originalTokens: 1000,
                    trimmedTokens: 800,
                    budget: 900,
                },
            });

            await capturedHandler!("after:transform", context);

            assert.ok(telemetryMock.captureRequestFailed.calledOnce);
            assert.ok(telemetryMock.captureTrimExecuted.calledOnce);
        });
    });

    suite("dispose", () => {
        test("disposes the registered hook disposable", () => {
            const hook = createPostHogHook();
            hook.initialize();
            hook.dispose();

            assert.ok(capturedDisposable.dispose.calledOnce);
        });

        test("can be called multiple times safely", () => {
            const hook = createPostHogHook();
            hook.initialize();
            hook.dispose();

            // Second dispose should not throw
            assert.doesNotThrow(() => hook.dispose());
        });
    });
});
