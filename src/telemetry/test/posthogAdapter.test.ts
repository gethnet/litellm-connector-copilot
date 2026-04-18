import * as assert from "assert";
import * as sinon from "sinon";
import { PostHogAdapter } from "../posthogAdapter";
import { PostHog } from "posthog-node";

suite("PostHogAdapter (Node)", () => {
    let sandbox: sinon.SinonSandbox;
    let envCiaValue: string | undefined;
    let envMockValue: string | undefined;
    let posthogCaptureExceptionStub: sinon.SinonStub;
    let posthogIdentifyStub: sinon.SinonStub;
    let posthogIsFeatureEnabledStub: sinon.SinonStub;
    let posthogReloadFeatureFlagsStub: sinon.SinonStub;
    let posthogFlushStub: sinon.SinonStub;
    let posthogShutdownStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        envCiaValue = process.env.CI;
        envMockValue = process.env.POSTHOG_MOCK;
        delete process.env.CI;
        delete process.env.POSTHOG_MOCK;
        posthogCaptureExceptionStub = sandbox.stub(PostHog.prototype, "captureException");
        posthogIdentifyStub = sandbox.stub(PostHog.prototype, "identify");
        posthogIsFeatureEnabledStub = sandbox.stub(PostHog.prototype, "isFeatureEnabled");
        posthogReloadFeatureFlagsStub = sandbox.stub(PostHog.prototype, "reloadFeatureFlags");
        posthogFlushStub = sandbox.stub(PostHog.prototype, "flush");
        posthogShutdownStub = sandbox.stub(PostHog.prototype, "shutdown");
    });

    teardown(() => {
        if (envCiaValue === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = envCiaValue;
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
            distinctId: "user-123",
            properties: {
                feature: "test-feature",
            },
            level: "error",
        });

        assert.strictEqual(posthogCaptureExceptionStub.calledOnce, true);
        const [capturedError, distinctId, properties] = posthogCaptureExceptionStub.firstCall.args;
        assert.strictEqual(capturedError, error);
        assert.strictEqual(distinctId, "user-123");
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

        assert.strictEqual(posthogIdentifyStub.calledOnce, true);
        const args = posthogIdentifyStub.firstCall.args[0];
        assert.strictEqual(args.distinctId, "user-123");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.strictEqual((args.properties as any).email, "test@example.com");
    });

    test("should check feature flags", async () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: true,
        });

        posthogIsFeatureEnabledStub.resolves(true);
        const enabled = await adapter.isFeatureEnabled("test-flag", "user-123");
        assert.strictEqual(enabled, true);
        assert.strictEqual(posthogIsFeatureEnabledStub.calledWith("test-flag", "user-123"), true);
    });

    test("captureException is a no-op before initialize", () => {
        const adapter = new PostHogAdapter();
        adapter.captureException(new Error("ignored"), { distinctId: "user-123" });
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

    test("isFeatureEnabled returns false when adapter is disabled", async () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: false,
        });

        const enabled = await adapter.isFeatureEnabled("test-flag", "user-123");
        assert.strictEqual(enabled, false);
        assert.strictEqual(posthogIsFeatureEnabledStub.called, false);
    });

    test("reloadFeatureFlags is a no-op when adapter is disabled", async () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: false,
        });

        await adapter.reloadFeatureFlags();
        assert.strictEqual(posthogReloadFeatureFlagsStub.called, false);
    });

    test("flush delegates to PostHog when enabled", async () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: true,
        });

        await adapter.flush();
        assert.strictEqual(posthogFlushStub.calledOnce, true);
    });

    test("shutdown delegates to PostHog when enabled", async () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: true,
        });

        await adapter.shutdown();
        assert.strictEqual(posthogShutdownStub.calledOnce, true);
    });
});
