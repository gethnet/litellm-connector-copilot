import * as assert from "assert";
import * as sinon from "sinon";
import { PostHogAdapter } from "../posthogAdapter";
import { PostHog } from "posthog-node";

suite("PostHogAdapter (Node)", () => {
    let sandbox: sinon.SinonSandbox;
    let envCiaValue: string | undefined;
    let envMockValue: string | undefined;
    let posthogCaptureStub: sinon.SinonStub;
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
        posthogCaptureStub = sandbox.stub(PostHog.prototype, "capture");
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
        interface CaptureExceptionProperties {
            feature?: string;
            groups?: Record<string, string>;
        }
        // posthog-node 6.x replaced the positional (error, distinctId, properties)
        // form with an options object; `level` is now the native severity
        // parameter (emitted as $exception_level) instead of a plain property.
        const args = posthogCaptureExceptionStub.firstCall.args as [
            unknown,
            { distinctId?: string; properties?: CaptureExceptionProperties; level?: string },
        ];
        const [capturedError, captureOptions] = args;
        assert.strictEqual(capturedError, error);
        assert.strictEqual(captureOptions.distinctId, "user-123");
        assert.strictEqual(captureOptions.properties?.feature, "test-feature");
        assert.strictEqual(captureOptions.level, "error");
    });

    test("should forward groups as event properties on captureException", () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: true,
        });

        // 6.x CaptureExceptionOptions has no native groups field; the adapter
        // must keep groups flowing as a plain event property (5.x wire shape).
        adapter.captureException(new Error("grouped-error"), {
            distinctId: "user-123",
            groups: { instance: "abc" },
        });

        const args = posthogCaptureExceptionStub.firstCall.args as [
            unknown,
            { properties?: { groups?: Record<string, string> } },
        ];
        assert.strictEqual(args[1]?.properties?.groups?.instance, "abc");
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
        const args = posthogIdentifyStub.firstCall.args[0] as {
            distinctId: string;
            properties: { email?: string };
        };
        assert.strictEqual(args.distinctId, "user-123");
        assert.strictEqual(args.properties.email, "test@example.com");
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

    test("does not forward review prompt telemetry while telemetry is disabled", () => {
        const adapter = new PostHogAdapter();
        adapter.initialize({
            apiKey: "test-key",
            host: "test-host",
            enabled: false,
        });

        adapter.capture({
            event: "review_prompt_choice",
            properties: {
                distinctId: "test-machine-id",
                choice: "later",
                install_date: 1764523200000,
                successful_turn_count: 10,
            },
        });

        assert.strictEqual(posthogCaptureStub.called, false);
    });
});
