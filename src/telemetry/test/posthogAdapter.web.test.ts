import * as assert from "assert";
import * as sinon from "sinon";
import { PostHogAdapter } from "../posthogAdapter.web";
import posthog from "posthog-js";

suite("PostHogAdapter (Web)", () => {
    let sandbox: sinon.SinonSandbox;
    let posthogCaptureExceptionStub: sinon.SinonStub;
    let posthogIdentifyStub: sinon.SinonStub;
    let posthogIsFeatureEnabledStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        posthogCaptureExceptionStub = sandbox.stub(posthog, "captureException");
        posthogIdentifyStub = sandbox.stub(posthog, "identify");
        posthogIsFeatureEnabledStub = sandbox.stub(posthog, "isFeatureEnabled");
    });

    teardown(() => {
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
});
