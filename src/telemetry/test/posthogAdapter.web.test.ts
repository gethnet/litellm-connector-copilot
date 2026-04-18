import * as assert from "assert";
import * as sinon from "sinon";
import { PostHogAdapter } from "../posthogAdapter.web";
import posthog from "posthog-js";

suite("PostHogAdapter (Web)", () => {
    let sandbox: sinon.SinonSandbox;
    let envCiValue: string | undefined;
    let envMockValue: string | undefined;
    let posthogCaptureExceptionStub: sinon.SinonStub;
    let posthogIdentifyStub: sinon.SinonStub;
    let posthogIsFeatureEnabledStub: sinon.SinonStub;
    let posthogReloadFeatureFlagsStub: sinon.SinonStub;
    let posthogResetStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        envCiValue = process.env.CI;
        envMockValue = process.env.POSTHOG_MOCK;
        delete process.env.CI;
        delete process.env.POSTHOG_MOCK;
        posthogCaptureExceptionStub = sandbox.stub(posthog, "captureException");
        posthogIdentifyStub = sandbox.stub(posthog, "identify");
        posthogIsFeatureEnabledStub = sandbox.stub(posthog, "isFeatureEnabled");
        posthogReloadFeatureFlagsStub = sandbox.stub(posthog, "reloadFeatureFlags");
        posthogResetStub = sandbox.stub(posthog, "reset");
    });

    teardown(() => {
        if (envCiValue === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = envCiValue;
        }
        if (envMockValue === undefined) {
            delete process.env.POSTHOG_MOCK;
        } else {
            process.env.POSTHOG_MOCK = envMockValue;
        }
        sandbox.restore();
    });

    test("should capture exceptions with correct properties", () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: true,
        });

        const error = new Error("test-error");
        adapter.captureException(error, {
            properties: {
                feature: "test-feature",
            },
            level: "error",
        });

        assert.strictEqual(posthogCaptureExceptionStub.calledOnce, true);
        const [capturedError, properties] = posthogCaptureExceptionStub.firstCall.args;
        assert.strictEqual(capturedError, error);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.strictEqual((properties as any).feature, "test-feature");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.strictEqual((properties as any).level, "error");
    });

    test("should identify users", () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: true,
        });

        adapter.identify("user-123", { email: "test@example.com" });

        assert.strictEqual(posthogIdentifyStub.calledWith("user-123", { email: "test@example.com" }), true);
    });

    test("should check feature flags", () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: true,
        });

        posthogIsFeatureEnabledStub.returns(true);
        const enabled = adapter.isFeatureEnabled("test-flag", "user-123");
        assert.strictEqual(enabled, true);
        assert.strictEqual(posthogIdentifyStub.calledWith("user-123"), true);
        assert.strictEqual(posthogIsFeatureEnabledStub.calledWith("test-flag"), true);
    });

    test("captureException is a no-op before initialize", () => {
        const adapter = new PostHogAdapter();
        adapter.captureException(new Error("ignored"), { level: "error" });
        assert.strictEqual(posthogCaptureExceptionStub.called, false);
    });

    test("identify is a no-op when adapter is disabled", () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: false,
        });

        adapter.identify("user-123", { email: "test@example.com" });
        assert.strictEqual(posthogIdentifyStub.called, false);
    });

    test("isFeatureEnabled returns false when adapter is disabled", () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: false,
        });

        const enabled = adapter.isFeatureEnabled("test-flag", "user-123");
        assert.strictEqual(enabled, false);
        assert.strictEqual(posthogIsFeatureEnabledStub.called, false);
    });

    test("reloadFeatureFlags is a no-op when adapter is disabled", () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: false,
        });

        adapter.reloadFeatureFlags();
        assert.strictEqual(posthogReloadFeatureFlagsStub.called, false);
    });

    test("shutdown delegates to PostHog reset when enabled", async () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: true,
        });

        await adapter.shutdown();
        assert.strictEqual(posthogResetStub.calledOnce, true);
    });
});
