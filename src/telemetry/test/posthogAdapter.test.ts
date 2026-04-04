import * as assert from "assert";
import * as sinon from "sinon";
import { PostHogAdapter } from "../posthogAdapter";
import { PostHog } from "posthog-node";

suite("PostHogAdapter (Node)", () => {
    let sandbox: sinon.SinonSandbox;
    let posthogCaptureExceptionStub: sinon.SinonStub;
    let posthogIdentifyStub: sinon.SinonStub;
    let posthogIsFeatureEnabledStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        posthogCaptureExceptionStub = sandbox.stub(PostHog.prototype, "captureException");
        posthogIdentifyStub = sandbox.stub(PostHog.prototype, "identify");
        posthogIsFeatureEnabledStub = sandbox.stub(PostHog.prototype, "isFeatureEnabled");
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
});
