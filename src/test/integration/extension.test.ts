import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import * as extension from "../../extension";
import * as providers from "../../providers";
import { Logger } from "../../utils/logger";
import { TelemetryService } from "../../telemetry/telemetryService";
import { LegacyConfigMigration } from "../../config/legacyConfigMigration";
import { createMockSecrets, createMockOutputChannel, createMockMemento } from "../utils/testMocks";

/**
 * Helper that wires up the common stubs every activation test needs so the
 * individual tests can stay focused on the behavior under test instead of
 * boilerplate. Returns a teardown function that restores sinon state and the
 * captured `vscode.commands.executeCommand` stub for direct assertions.
 */
/**
 * Wires up the common stubs every activation test needs.  Each test must
 * call this exactly once: a second `sandbox.stub` on the same property
 * throws because sinon sees the prior wrap.
 */
function stubActivationEnvironment(
    sandbox: sinon.SinonSandbox,
    _context: vscode.ExtensionContext
): {
    registerProviderStub: sinon.SinonStub;
    executeCommandStub: sinon.SinonStub;
    refreshStub: sinon.SinonStub;
    showInfoStub: sinon.SinonStub;
    configChangeHandler: () => ((e: vscode.ConfigurationChangeEvent) => void) | undefined;
    onModernConfigDetected: () => (() => void) | undefined;
    telemetry: ReturnType<typeof stubTelemetryService>;
} {
    sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());
    sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
    const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined);
    const registerProviderStub = sandbox
        .stub(vscode.lm, "registerLanguageModelChatProvider")
        .returns({ dispose() {} } as vscode.Disposable);
    sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);
    const executeCommandStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);
    const refreshStub = sandbox.stub(providers.LiteLLMChatProvider.prototype, "refreshModelInformation");
    sandbox.stub(providers.LiteLLMChatProvider.prototype, "setTelemetryService");
    const setModernHandlerStub = sandbox.stub(
        providers.LiteLLMChatProvider.prototype,
        "setModernConfigurationDetectedHandler"
    );

    let capturedConfigHandler: ((e: vscode.ConfigurationChangeEvent) => void) | undefined;
    sandbox.stub(vscode.workspace, "onDidChangeConfiguration").callsFake((listener) => {
        capturedConfigHandler = listener as (e: vscode.ConfigurationChangeEvent) => void;
        return { dispose() {} } as vscode.Disposable;
    });
    let capturedModernHandler: (() => void) | undefined;
    setModernHandlerStub.callsFake((handler: () => void) => {
        capturedModernHandler = handler;
    });

    return {
        registerProviderStub,
        executeCommandStub,
        refreshStub,
        showInfoStub,
        configChangeHandler: () => capturedConfigHandler,
        onModernConfigDetected: () => capturedModernHandler,
        telemetry: stubTelemetryService(sandbox),
    };
}

/**
 * Stubs `TelemetryService` at the prototype level so every instance the
 * `activate` function constructs will funnel its capture*() calls into the
 * sinon stubs we return. Tests can then assert on telemetry side-effects
 * without standing up a real PostHog adapter.
 */
function stubTelemetryService(sandbox: sinon.SinonSandbox): {
    captureException: sinon.SinonStub;
    captureExtensionActivated: sinon.SinonStub;
    captureFeatureAdoption: sinon.SinonStub;
    captureFeatureUsageSnapshot: sinon.SinonStub;
    captureModernConfigStatus: sinon.SinonStub;
} {
    return {
        captureException: sandbox.stub(TelemetryService.prototype, "captureException"),
        captureExtensionActivated: sandbox.stub(TelemetryService.prototype, "captureExtensionActivated"),
        captureFeatureAdoption: sandbox.stub(TelemetryService.prototype, "captureFeatureAdoption"),
        captureFeatureUsageSnapshot: sandbox.stub(TelemetryService.prototype, "captureFeatureUsageSnapshot"),
        captureModernConfigStatus: sandbox.stub(TelemetryService.prototype, "captureModernConfigStatus"),
    };
}

/**
 * Builds a minimal mock context that already includes `globalState` and
 * `workspaceState` so the migration notice / modern config flag paths in
 * `activate` execute their bodies instead of bailing out.
 */
function createContextWithState(
    sandbox: sinon.SinonSandbox,
    seed: { globalState?: Record<string, unknown>; workspaceState?: Record<string, unknown> } = {}
): vscode.ExtensionContext {
    return {
        subscriptions: [],
        secrets: createMockSecrets(),
        globalState: createMockMemento(seed.globalState),
        workspaceState: createMockMemento(seed.workspaceState),
    } as unknown as vscode.ExtensionContext;
}

/**
 * Activates the extension under the given context.  The activation is
 * intercepted by the suite-level `setup` hook, which records the context
 * for teardown disposal (which detaches the process error listeners).
 */
function activateAndTrack(context: vscode.ExtensionContext): void {
    extension.activate(context);
}

suite("Extension Activation Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let activeContexts: vscode.ExtensionContext[] = [];

    setup(() => {
        sandbox = sinon.createSandbox();
        activeContexts = [];
        (extension as unknown as { __activeContexts: vscode.ExtensionContext[] }).__activeContexts = activeContexts;
        // Wrap `extension.activate` so any test that calls it (including the
        // original tests that pre-date this helper) is recorded for teardown.
        const realActivate = extension.activate;
        const stub = sandbox.stub(extension, "activate");
        stub.callsFake((ctx: vscode.ExtensionContext) => {
            activeContexts.push(ctx);
            realActivate(ctx);
        });
        const fn = vscode.window.createOutputChannel as unknown as {
            restore?: { sinon?: boolean };
        };
        // Surface a wrap from the previous test in the test output; harmless
        // even if `restore.sinon` is absent.
        if (fn.restore?.sinon) {
            console.warn("[setup] createOutputChannel still wrapped from previous test");
        }
    });

    teardown(async () => {
        // Dispose every context registered during the test so process
        // listeners (uncaughtException / unhandledRejection) get detached
        // before the next test stubs the same APIs again.
        for (const ctx of activeContexts) {
            for (const sub of ctx.subscriptions) {
                try {
                    sub.dispose();
                } catch {
                    // ignore disposal errors
                }
            }
        }
        activeContexts = [];
        // Drain any pending `setImmediate` callbacks scheduled by `activate`
        // (e.g. the post-registration refresh) and by the migration path
        // (a 500ms `setTimeout` and a 250ms debounced refresh).  We loop
        // several iterations to ensure all queued microtasks/immediates run
        // before we restore the sandbox, so any wrap of `createOutputChannel`
        // made inside a deferred callback is unwound first.
        for (let i = 0; i < 10; i += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        // Restore the sandbox first so the wrap of `createOutputChannel`
        // (and friends) is removed before the next test's setup runs.
        sandbox.restore();
    });

    test("activate registers providers and commands", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        // Avoid touching real output channels.
        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        // UA builder.
        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        // vscode.version is a non-configurable property in the test host; don't stub it.

        // Avoid unexpected UI prompts.
        sandbox.stub(vscode.window, "showInformationMessage");

        // Provider registration.
        const lmReg = { dispose() {} } as vscode.Disposable;
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns(lmReg);

        // Commands registration.
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        // Ensure chat provider can be constructed without side effects.
        sandbox.stub(providers.LiteLLMChatProvider.prototype, "getLastKnownModels").returns([]);

        extension.activate(context);

        // Should have pushed registrar + lm registration + multiple command disposables.
        assert.ok(context.subscriptions.length >= 2);
    });

    test("activate constructs chat provider with secrets and UA", async () => {
        const mockSecrets = createMockSecrets();
        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());
        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(vscode.window, "showInformationMessage");

        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);
        const registerProviderStub = sandbox
            .stub(vscode.lm, "registerLanguageModelChatProvider")
            .returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);

        assert.strictEqual(registerProviderStub.calledOnce, true);
    });

    test("activate does not refresh model info after configuration changes", async () => {
        const mockSecrets = createMockSecrets();
        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());
        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(vscode.window, "showInformationMessage");
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        const clearModelCacheStub = sandbox.stub(providers.LiteLLMChatProvider.prototype, "clearModelCache");

        let configChangeHandler: ((e: vscode.ConfigurationChangeEvent) => void) | undefined;
        sandbox.stub(vscode.workspace, "onDidChangeConfiguration").callsFake((listener) => {
            configChangeHandler = listener as (e: vscode.ConfigurationChangeEvent) => void;
            return { dispose() {} } as vscode.Disposable;
        });

        extension.activate(context);
        assert.ok(configChangeHandler, "expected onDidChangeConfiguration handler to be registered");

        // Trigger config change WITHOUT affecting litellm-connector config - should not refresh
        const mockEvent = {
            affectsConfiguration: (section: string): boolean => {
                return section === "litellm-connector.someOtherSetting";
            },
        };
        configChangeHandler(mockEvent);
        await new Promise((resolve) => setTimeout(resolve, 300));

        assert.strictEqual(clearModelCacheStub.calledOnce, false);
    });

    test("deactivate does not clear configuration", async () => {
        // Ensure Logger doesn't explode if used during deactivate.
        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        const context = {
            subscriptions: [],
            secrets: {} as vscode.SecretStorage,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        // vscode.version is a non-configurable property in the test host; don't stub it.
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);
        await extension.deactivate();
        // No cleanup should be triggered on deactivate; settings/secrets should persist.
    });

    test("activate persists modern config session flag when provider detects valid config", async () => {
        const mockSecrets = createMockSecrets();
        const workspaceState = createMockMemento();
        const updateSpy = sandbox.spy(workspaceState, "update");

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
            workspaceState,
        } as unknown as vscode.ExtensionContext;

        let onModernConfigDetected: (() => void) | undefined;
        sandbox
            .stub(providers.LiteLLMChatProvider.prototype, "setModernConfigurationDetectedHandler")
            .callsFake((handler: () => void) => {
                onModernConfigDetected = handler;
            });

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());
        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(vscode.window, "showInformationMessage");
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);

        onModernConfigDetected?.();

        assert.strictEqual(updateSpy.calledWith("litellm-connector.isOnModernConfig", true), true);
    });

    test("deactivate tolerates repeated disposal", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);
        await extension.deactivate();
        await extension.deactivate();
        assert.ok(true, "Repeated deactivate should not throw");
    });

    test("activate handles missing extension object gracefully", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        // Extension not found.
        sandbox.stub(vscode.extensions, "getExtension").returns(undefined);
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);
        assert.ok(context.subscriptions.length > 0);
    });

    test("activate handles registration failure gracefully", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);

        // Throw during registration.
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").throws(new Error("reg failed"));
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);
        // Should not throw and continue activation.
        assert.ok(context.subscriptions.length > 0);
    });

    // -------------------------------------------------------------------------
    // Bulk coverage tests for the remaining extension.ts lines. Each test in
    // the suite below covers multiple uncovered branches in `activate` to keep
    // the test count small while raising line/branch coverage.
    // -------------------------------------------------------------------------

    test("activate wires process error listeners and removes them on dispose", async () => {
        const context = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, context);
        // Capture the listeners that `activate` registers on `process` so we
        // can call them directly.  We intercept `process.on` for our two
        // events of interest only; all other `process.on` calls (e.g. Node
        // internals) flow through the real `process.on` so the event loop
        // continues to function.
        const captured: Record<string, ((...args: unknown[]) => void)[]> = {
            uncaughtException: [],
            unhandledRejection: [],
        };
        const realOn = process.on.bind(process);
        const onStub = ((event: string | symbol, listener: (...args: unknown[]) => void): NodeJS.Process => {
            if (event === "uncaughtException" || event === "unhandledRejection") {
                captured[event as "uncaughtException" | "unhandledRejection"].push(listener);
            }
            return realOn(event as Parameters<typeof process.on>[0], listener as Parameters<typeof process.on>[1]);
        }) as never;
        sandbox.stub(process, "on").callsFake(onStub);

        activateAndTrack(context);

        // Fire each captured listener directly with matching/non-matching input.
        // This avoids triggering Mocha's own uncaughtException handler, which
        // would fail the test.
        const fireOn = (event: "uncaughtException" | "unhandledRejection", payload: unknown): void => {
            for (const listener of captured[event]) {
                listener(payload);
            }
        };

        const uncaught = new Error("boom");
        uncaught.stack = "Error: boom\n    at litellm-connector-copilot:1:1";
        fireOn("uncaughtException", uncaught);

        const rejection = new Error("rej");
        rejection.stack = "Error: rej\n    at litellm-connector:1:1";
        fireOn("unhandledRejection", rejection);

        // Non-Error rejection (must not crash, must not call capture).
        fireOn("unhandledRejection", "plain string");

        // Unrelated stack must be ignored.
        const unrelated = new Error("unrelated");
        unrelated.stack = "Error: unrelated\n    at other:1:1";
        fireOn("uncaughtException", unrelated);

        // Allow any microtasks queued by the listener bodies to drain.
        await new Promise((resolve) => setImmediate(resolve));

        // The capture calls should be exactly 2 (uncaught + rejection) with
        // the matching caller names.
        const calls = env.telemetry.captureException.getCalls();
        const callers = calls.map((c) => (c.args[1] as { caller?: string } | undefined)?.caller);
        assert.ok(
            callers.includes("uncaughtException"),
            "uncaughtException listener should fire telemetry with the scoped caller"
        );
        assert.ok(
            callers.includes("unhandledRejection"),
            "unhandledRejection listener should fire telemetry with the scoped caller"
        );
        assert.strictEqual(calls.length, 2, "unrelated stacks and non-Error rejections must be ignored");

        // Exercise the dispose callback that detaches the listeners by
        // disposing every subscription registered on the context.  Verify
        // the detachment by checking that `process.listeners` no longer
        // contains the original listeners (a stable identity comparison
        // against the references we captured).
        const preDetach = {
            uncaughtException: process.listeners("uncaughtException").slice(),
            unhandledRejection: process.listeners("unhandledRejection").slice(),
        };
        for (const sub of context.subscriptions) {
            sub.dispose();
        }
        const postDetach = {
            uncaughtException: process.listeners("uncaughtException"),
            unhandledRejection: process.listeners("unhandledRejection"),
        };
        for (const capturedListener of captured.uncaughtException) {
            assert.strictEqual(
                postDetach.uncaughtException.includes(capturedListener as NodeJS.UncaughtExceptionListener),
                false,
                "uncaughtException listener should be detached after dispose"
            );
        }
        for (const capturedListener of captured.unhandledRejection) {
            assert.strictEqual(
                postDetach.unhandledRejection.includes(capturedListener as NodeJS.UnhandledRejectionListener),
                false,
                "unhandledRejection listener should be detached after dispose"
            );
        }
        // preDetach is referenced for readability; mark as used.
        assert.ok(preDetach, "captured pre-dispose listener list");
    });

    test("activate opens Language Models when user accepts the migration notice", async () => {
        const ctx = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, ctx);
        env.showInfoStub.resolves("Open Language Models" as unknown as string);
        activateAndTrack(ctx);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(
            env.executeCommandStub.calledWith("workbench.action.chat.manage"),
            true,
            "chat.manage should be invoked when user accepts the notice"
        );
    });

    test("activate does not run any command when user dismisses the migration notice", async () => {
        const ctx = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, ctx);
        env.showInfoStub.resolves(undefined);
        activateAndTrack(ctx);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(
            env.executeCommandStub.calledWith("workbench.action.chat.manage"),
            false,
            "no command should run when the user dismisses the notice"
        );
    });

    test("activate falls back to openSettings when chat.manage rejects", async () => {
        const ctx = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, ctx);
        env.showInfoStub.resolves("Open Language Models" as unknown as string);
        env.executeCommandStub.withArgs("workbench.action.chat.manage").rejects(new Error("missing"));
        activateAndTrack(ctx);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(
            env.executeCommandStub.calledWith("workbench.action.openSettings", "@tag:language-model"),
            true,
            "fallback to openSettings when chat.manage rejects"
        );
    });

    test("activate suppresses the migration notice once it has been shown", async () => {
        const ctx = createContextWithState(sandbox, {
            globalState: { "litellm-connector.migrationNotice.v1": true },
        });
        const env = stubActivationEnvironment(sandbox, ctx);
        activateAndTrack(ctx);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(env.showInfoStub.called, false, "notice must not reappear once shown");
    });

    test("activate warns when workspaceState is unavailable and the modern config handler is invoked", async () => {
        const ctx = {
            subscriptions: [],
            secrets: createMockSecrets(),
            globalState: createMockMemento(),
            // intentionally no workspaceState
        } as unknown as vscode.ExtensionContext;
        const env = stubActivationEnvironment(sandbox, ctx);
        const warnSpy = sandbox.stub(Logger, "warn");
        activateAndTrack(ctx);
        const handler = env.onModernConfigDetected();
        assert.ok(handler, "modern config handler should have been registered");
        handler();
        // Allow the fire-and-forget async IIFE inside the handler to settle.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(
            warnSpy.calledWith("workspaceState unavailable; cannot persist modern configuration session flag"),
            true
        );
    });

    test("activate emits a telemetry event for the already-marked modern config branch", async () => {
        const ctx = createContextWithState(sandbox, {
            workspaceState: { "litellm-connector.isOnModernConfig": true },
        });
        const env = stubActivationEnvironment(sandbox, ctx);
        activateAndTrack(ctx);
        const handler = env.onModernConfigDetected();
        assert.ok(handler, "handler should be registered for already-marked case");
        handler();
        assert.strictEqual(
            env.telemetry.captureModernConfigStatus.calledWith({
                is_on_modern_config: true,
                source: "provider_configuration_detected",
            }),
            true,
            "already-marked branch should emit a modern-config telemetry event"
        );
    });

    test("activate persists and emits a telemetry event for the happy path of modern config detection", async () => {
        const ctx = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, ctx);
        activateAndTrack(ctx);
        const handler = env.onModernConfigDetected();
        assert.ok(handler);
        handler();
        // The handler fires a fire-and-forget async IIFE; give it a few
        // microtask/immediate cycles to settle before asserting.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(
            env.telemetry.captureModernConfigStatus.calledWith({
                is_on_modern_config: true,
                source: "provider_configuration_detected",
            }),
            true,
            "happy path should capture a modern-config telemetry event"
        );
    });

    test("activate logs and swallows persistence errors during modern config detection", async () => {
        const ctx = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, ctx);
        const ctxState = (ctx as unknown as { workspaceState: vscode.Memento }).workspaceState;
        sandbox.stub(ctxState, "update").rejects(new Error("store down"));
        const errorSpy = sandbox.stub(Logger, "error");
        activateAndTrack(ctx);
        const handler = env.onModernConfigDetected();
        assert.ok(handler);
        handler();
        // Allow the fire-and-forget async IIFE inside the handler to settle.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(
            errorSpy.calledWith("Failed to persist modern configuration session flag", sinon.match.any),
            true,
            "persistence failures should be logged, not propagated"
        );
    });

    test("activate fires the post-registration refresh and tracks the provider registration in subscriptions", async () => {
        const ctx = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, ctx);
        // Replace the stub with one that returns a spyable disposable.
        env.registerProviderStub.restore();
        const regDisposable = { dispose: sinon.spy() } as unknown as vscode.Disposable & {
            dispose: sinon.SinonSpy;
        };
        sandbox
            .stub(vscode.lm, "registerLanguageModelChatProvider")
            .returns(regDisposable as unknown as vscode.Disposable);
        activateAndTrack(ctx);
        // setImmediate should fire the post-registration refresh.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(env.refreshStub.called, true, "post-registration refresh should run");
        assert.ok(
            ctx.subscriptions.includes(regDisposable as vscode.Disposable),
            "first registration should be tracked in subscriptions"
        );
    });

    test("activate logs an error when registerLanguageModelChatProvider returns null", async () => {
        const ctx = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, ctx);
        env.registerProviderStub.restore();
        const errorSpy = sandbox.stub(Logger, "error");
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns(undefined as unknown as vscode.Disposable);
        activateAndTrack(ctx);
        assert.strictEqual(
            errorSpy.calledWith("registerLanguageModelChatProvider returned undefined/null"),
            true,
            "null return from register should be logged"
        );
    });

    test("activate refreshes model information when litellm-connector settings change and registers commands", async () => {
        const ctx = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, ctx);
        const infoSpy = sandbox.stub(Logger, "info");
        activateAndTrack(ctx);

        // The setImmediate refresh was already covered above. Here we exercise
        // the onDidChangeConfiguration branch that triggers the 250ms debounce.
        const handler = env.configChangeHandler();
        assert.ok(handler, "config change handler should be registered");

        // modelOverrides changed -> should debounce and then refresh.
        handler({
            affectsConfiguration: (section: string): boolean => section === "litellm-connector.modelOverrides",
        });
        // backendGroups changed -> should also trigger.
        handler({
            affectsConfiguration: (section: string): boolean => section === "litellm-connector.backendGroups",
        });
        // Unrelated change -> must NOT trigger.
        const before = env.refreshStub.callCount;
        handler({ affectsConfiguration: () => false });
        assert.strictEqual(env.refreshStub.callCount, before, "unrelated config changes must not refresh");
        // Wait for the debounce timer to fire.
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.strictEqual(env.refreshStub.callCount > before, true, "refresh should fire after debounce");

        // The "Config command registered." log should have been emitted.
        assert.strictEqual(infoSpy.calledWith("Config command registered."), true);
    });

    test("activate skips refresh when legacy migration reports no migration", async () => {
        const ctx = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, ctx);
        sandbox.stub(LegacyConfigMigration.prototype, "runMigrationIfNeeded").resolves({
            migrated: false,
            groupsCreated: 0,
            groupNames: [],
            cleanupComplete: false,
            errors: [],
        });
        activateAndTrack(ctx);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.strictEqual(
            env.refreshStub.callCount <= 1, // may be 1 from setImmediate
            true,
            "non-migrated result should not trigger a migration-driven refresh"
        );
    });

    test("activate logs and refreshes when legacy migration succeeds", async () => {
        const ctx = createContextWithState(sandbox);
        const env = stubActivationEnvironment(sandbox, ctx);
        const refreshBefore = env.refreshStub.callCount;
        const infoSpy = sandbox.stub(Logger, "info");
        sandbox.stub(LegacyConfigMigration.prototype, "runMigrationIfNeeded").resolves({
            migrated: true,
            groupsCreated: 2,
            groupNames: ["g1", "g2"],
            cleanupComplete: true,
            errors: [],
        });
        activateAndTrack(ctx);
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.strictEqual(
            infoSpy.calledWith("Migration completed: 2 groups created"),
            true,
            "successful migration should log group count"
        );
        assert.strictEqual(
            env.refreshStub.callCount > refreshBefore,
            true,
            "successful migration should schedule a refresh"
        );
    });

    test("activate logs and swallows legacy migration rejections", async () => {
        const ctx = createContextWithState(sandbox);
        stubActivationEnvironment(sandbox, ctx);
        const errorSpy = sandbox.stub(Logger, "error");
        sandbox.stub(LegacyConfigMigration.prototype, "runMigrationIfNeeded").rejects(new Error("boom"));
        activateAndTrack(ctx);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(
            errorSpy.calledWith("Migration check failed", sinon.match.any),
            true,
            "migration rejections should be logged"
        );
    });
});
