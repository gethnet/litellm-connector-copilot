import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { TelemetryService } from "../telemetryService";
import { PostHogAdapter } from "../posthogAdapter";

suite("TelemetryService", () => {
    let sandbox: sinon.SinonSandbox;
    let telemetryService: TelemetryService;
    let adapterMock: sinon.SinonStubbedInstance<PostHogAdapter>;

    setup(() => {
        sandbox = sinon.createSandbox();
        adapterMock = sandbox.createStubInstance(PostHogAdapter);

        // Mock vscode.env.isTelemetryEnabled
        sandbox.stub(vscode.env, "isTelemetryEnabled").get(() => true);
        sandbox.stub(vscode.env, "machineId").get(() => "test-machine-id");
        sandbox.stub(vscode.env, "sessionId").get(() => "test-crash-reporter-id");

        telemetryService = new TelemetryService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (telemetryService as any).adapter = adapterMock;
    });

    teardown(() => {
        sandbox.restore();
    });

    test("should initialize with correct settings", () => {
        const mockContext = {
            extension: {
                packageJSON: {
                    version: "1.0.0",
                },
            },
        } as unknown as vscode.ExtensionContext;

        telemetryService.initialize(mockContext);

        assert.strictEqual(adapterMock.initialize.calledOnce, true);
        const config = adapterMock.initialize.firstCall.args[0];
        assert.strictEqual(config.apiKey, TelemetryService.POSTHOG_API_KEY);
        assert.strictEqual(config.host, TelemetryService.POSTHOG_HOST);
        assert.strictEqual(config.enabled, true);
    });

    test("should capture events with correct properties", () => {
        const mockContext = {
            extension: {
                packageJSON: {
                    version: "1.0.0",
                },
            },
        } as unknown as vscode.ExtensionContext;

        telemetryService.initialize(mockContext);
        telemetryService.captureChatRequest({
            request_id: "test-request-id",
            caller: "test-caller",
            model: "test-model",
            endpoint: "test-endpoint",
            durationMs: 100,
            tokensIn: 10,
            tokensOut: 20,
            status: "success",
        });

        assert.strictEqual(adapterMock.capture.calledOnce, true);
        const event = adapterMock.capture.firstCall.args[0];
        assert.strictEqual(event.event, "chat_request");
        assert.strictEqual(event.properties.request_id, "test-request-id");
        assert.strictEqual(event.properties.caller, "test-caller");
        assert.strictEqual(event.properties.model, "test-model");
        assert.strictEqual(event.properties.distinctId, "test-machine-id");
        assert.strictEqual(event.properties.extension_version, "1.0.0");
    });

    test("captureChatRequest includes request_id when provided", () => {
        const mockContext = {
            extension: {
                packageJSON: {
                    version: "1.0.0",
                },
            },
        } as unknown as vscode.ExtensionContext;

        telemetryService.initialize(mockContext);
        telemetryService.captureChatRequest({
            request_id: "req-chat-123",
            caller: "test-caller",
            model: "test-model",
            endpoint: "test-endpoint",
            durationMs: 100,
            tokensIn: 10,
            tokensOut: 20,
            status: "success",
        });

        assert.strictEqual(adapterMock.capture.calledOnce, true);
        const event = adapterMock.capture.firstCall.args[0];
        assert.strictEqual(event.event, "chat_request");
        assert.strictEqual(event.properties.request_id, "req-chat-123");
        assert.strictEqual(event.properties.distinctId, "test-machine-id");
    });

    test("captureRequestCompleted includes request_id when provided", () => {
        const mockContext = {
            extension: {
                packageJSON: {
                    version: "1.0.0",
                },
            },
        } as unknown as vscode.ExtensionContext;

        telemetryService.initialize(mockContext);
        telemetryService.captureRequestCompleted({
            request_id: "req-complete-123",
            caller: "inline-completions",
            model: "test-model",
            endpoint: "/chat/completions",
            durationMs: 42,
            tokensIn: 7,
            tokensOut: 11,
        });

        assert.strictEqual(adapterMock.capture.calledOnce, true);
        const event = adapterMock.capture.firstCall.args[0];
        assert.strictEqual(event.event, "request_completed");
        assert.strictEqual(event.properties.request_id, "req-complete-123");
        assert.strictEqual(event.properties.caller, "inline-completions");
    });

    test("captureRequestFailed includes request_id when provided", () => {
        const mockContext = {
            extension: {
                packageJSON: {
                    version: "1.0.0",
                },
            },
        } as unknown as vscode.ExtensionContext;

        telemetryService.initialize(mockContext);
        telemetryService.captureRequestFailed({
            request_id: "req-fail-123",
            caller: "chat",
            model: "test-model",
            endpoint: "unknown",
            durationMs: 12,
            errorType: "boom",
        });

        assert.strictEqual(adapterMock.capture.calledOnce, true);
        const event = adapterMock.capture.firstCall.args[0];
        assert.strictEqual(event.event, "request_failed");
        assert.strictEqual(event.properties.request_id, "req-fail-123");
        assert.strictEqual(event.properties.errorType, "boom");
    });

    test("request telemetry preserves request_id as a flat searchable property", () => {
        const mockContext = {
            extension: {
                packageJSON: {
                    version: "1.0.0",
                },
            },
        } as unknown as vscode.ExtensionContext;

        telemetryService.initialize(mockContext);
        telemetryService.captureRequestFailed({
            request_id: "req-flat-123",
            caller: "chat",
            model: "test-model",
            endpoint: "unknown",
            durationMs: 1,
            errorType: "failure",
        });

        assert.strictEqual(adapterMock.capture.calledOnce, true);
        const event = adapterMock.capture.firstCall.args[0];
        assert.strictEqual(typeof event.properties.request_id, "string");
        assert.strictEqual(event.properties.request_id, "req-flat-123");
    });

    test("should capture exceptions with correct properties", () => {
        const mockContext = {
            extension: {
                packageJSON: {
                    version: "1.0.0",
                },
            },
        } as unknown as vscode.ExtensionContext;

        telemetryService.initialize(mockContext);
        const error = new Error("test-error");
        telemetryService.captureException(error, {
            caller: "scm-generator",
            properties: {
                feature: "test-feature",
            },
        });

        assert.strictEqual(adapterMock.captureException.calledOnce, true);
        const [capturedError, options] = adapterMock.captureException.firstCall.args;
        assert.strictEqual(capturedError, error);
        assert.strictEqual(options?.caller, "scm-generator");
        assert.strictEqual(options?.properties?.feature, "test-feature");
        assert.strictEqual(options?.properties?.distinctId, "test-machine-id");
        assert.strictEqual(options?.properties?.extension_version, "1.0.0");
    });

    test("should identify users with crash reporter id and extension version", () => {
        const mockContext = {
            extension: {
                packageJSON: {
                    version: "1.0.0",
                },
            },
        } as unknown as vscode.ExtensionContext;

        telemetryService.initialize(mockContext);
        telemetryService.identify("test-machine-id", { email: "test@example.com" });

        assert.strictEqual(adapterMock.identify.calledOnce, true);
        const [distinctId, properties] = adapterMock.identify.firstCall.args;
        assert.strictEqual(distinctId, "test-machine-id");
        assert.strictEqual(properties?.email, "test@example.com");
        assert.strictEqual(properties?.extension_version, "1.0.0");
    });

    test("should check feature flags", async () => {
        const mockContext = {
            extension: {
                packageJSON: {
                    version: "1.0.0",
                },
            },
        } as unknown as vscode.ExtensionContext;

        telemetryService.initialize(mockContext);
        adapterMock.isFeatureEnabled.resolves(true);
        const enabled = await telemetryService.isFeatureEnabled("test-flag");
        assert.strictEqual(enabled, true);
        assert.strictEqual(adapterMock.isFeatureEnabled.calledWith("test-flag", "test-machine-id"), true);
    });

    test("should respect telemetry enabled setting changes", () => {
        const mockContext = {
            extension: {
                packageJSON: {
                    version: "1.0.0",
                },
            },
        } as unknown as vscode.ExtensionContext;

        const onDidChangeEmitter = new vscode.EventEmitter<boolean>();
        sandbox.stub(vscode.env, "onDidChangeTelemetryEnabled").get(() => onDidChangeEmitter.event);

        telemetryService.initialize(mockContext);

        onDidChangeEmitter.fire(false);
        assert.strictEqual(adapterMock.setEnabled.calledWith(false), true);

        onDidChangeEmitter.fire(true);
        assert.strictEqual(adapterMock.setEnabled.calledWith(true), true);
    });

    test("captureFeatureUsageSnapshot sends correct event", () => {
        const mockContext = {
            extension: { packageJSON: { version: "1.0.0" } },
        } as unknown as vscode.ExtensionContext;
        telemetryService.initialize(mockContext);

        const features = {
            "inline-completions": true,
            "responses-api": false,
            "commit-message": true,
            "usage-data": false,
            caching: true,
            "quota-tool-redaction": true,
        };
        telemetryService.captureFeatureUsageSnapshot(features);

        assert.strictEqual(adapterMock.capture.calledOnce, true);
        const event = adapterMock.capture.firstCall.args[0];
        assert.strictEqual(event.event, "feature_usage_snapshot");
        assert.strictEqual(event.properties["inline-completions"], true);
        assert.strictEqual(event.properties["responses-api"], false);
        assert.strictEqual(event.properties["commit-message"], true);
        assert.strictEqual(event.properties.distinctId, "test-machine-id");
    });

    test("captureFeatureToggled sends correct event", () => {
        const mockContext = {
            extension: { packageJSON: { version: "1.0.0" } },
        } as unknown as vscode.ExtensionContext;
        telemetryService.initialize(mockContext);

        telemetryService.captureFeatureToggled("inline-completions", true, "config_change");

        assert.strictEqual(adapterMock.capture.calledOnce, true);
        const event = adapterMock.capture.firstCall.args[0];
        assert.strictEqual(event.event, "feature_toggled");
        assert.strictEqual(event.properties.feature_name, "inline-completions");
        assert.strictEqual(event.properties.enabled, true);
        assert.strictEqual(event.properties.source, "config_change");
    });

    test("captureFeatureUsed aggregates events", () => {
        const mockContext = {
            extension: { packageJSON: { version: "1.0.0" } },
        } as unknown as vscode.ExtensionContext;
        telemetryService.initialize(mockContext);

        telemetryService.captureFeatureUsed("chat", "inline-edit");

        // Should be aggregated, not captured yet
        assert.strictEqual(adapterMock.capture.called, false);
    });

    suite("Aggregated Feature Usage", () => {
        let clock: sinon.SinonFakeTimers;

        setup(() => {
            clock = sandbox.useFakeTimers();
            // Re-create service AFTER fake timers started
            telemetryService = new TelemetryService();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (telemetryService as any).adapter = adapterMock;
        });

        teardown(() => {
            clock.restore();
        });

        test("should aggregate feature usage events and flush after interval", () => {
            const mockContext = { packageJSON: { version: "1.0.0" } } as unknown as vscode.ExtensionContext;
            telemetryService.initialize(mockContext);

            // Trigger some feature usage
            telemetryService.captureFeatureUsed("chat", "test");
            telemetryService.captureFeatureUsed("chat", "test");
            telemetryService.captureFeatureUsed("inline-completions", "test");

            // Should not have captured anything yet (aggregated)
            assert.strictEqual(adapterMock.capture.called, false);

            // Tick forward 15 minutes
            clock.tick(15 * 60 * 1000);
            telemetryService.captureFeatureUsed("other", "test"); // This call should trigger flush of PRIOR aggregation

            assert.strictEqual(adapterMock.capture.calledOnce, true);
            const event = adapterMock.capture.firstCall.args[0];
            assert.strictEqual(event.event, "feature_used_aggregated");
            const features = JSON.parse(event.properties.features as string);
            assert.strictEqual(features["chat"], 2);
            assert.strictEqual(features["inline-completions"], 1);
            assert.strictEqual(features["other"], undefined); // "other" is in the NEXT aggregation
            assert.strictEqual(event.properties.period_minutes, 15);
        });

        test("should not flush if no features used", () => {
            const mockContext = { packageJSON: { version: "1.0.0" } } as unknown as vscode.ExtensionContext;
            telemetryService.initialize(mockContext);

            clock.tick(15 * 60 * 1000);
            telemetryService.captureFeatureUsed("chat", "test");

            // First one after interval flushes PRIOR state. Since PRIOR was empty, should NOT have flushed yet.
            assert.strictEqual(adapterMock.capture.called, false);
        });
    });

    suite("Model Usage Tracking", () => {
        test("should capture model_used and provider_used events", () => {
            const mockContext = { packageJSON: { version: "1.0.0" } } as unknown as vscode.ExtensionContext;
            telemetryService.initialize(mockContext);

            telemetryService.captureModelUsed("openai/gpt-4o", "chat");

            assert.strictEqual(adapterMock.capture.calledTwice, true);

            const modelEvent = adapterMock.capture.firstCall.args[0];
            assert.strictEqual(modelEvent.event, "model_used");
            assert.strictEqual(modelEvent.properties.model_id, "openai/gpt-4o");
            assert.strictEqual(modelEvent.properties.caller, "chat");

            const providerEvent = adapterMock.capture.secondCall.args[0];
            assert.strictEqual(providerEvent.event, "provider_used");
            assert.strictEqual(providerEvent.properties.provider, "openai");
            assert.strictEqual(providerEvent.properties.caller, "chat");
        });

        test("should handle modelId without provider prefix", () => {
            const mockContext = { packageJSON: { version: "1.0.0" } } as unknown as vscode.ExtensionContext;
            telemetryService.initialize(mockContext);

            telemetryService.captureModelUsed("gpt-4o", "chat");

            const providerEvent = adapterMock.capture.secondCall.args[0];
            assert.strictEqual(providerEvent.properties.provider, "gpt-4o"); // Fallback to full id if no /
        });
    });

    suite("Feature Adoption Tracking", () => {
        test("should capture feature_adoption events", () => {
            const mockContext = { packageJSON: { version: "1.0.0" } } as unknown as vscode.ExtensionContext;
            telemetryService.initialize(mockContext);

            telemetryService.captureFeatureAdoption("chat");

            assert.strictEqual(adapterMock.capture.calledOnce, true);
            const event = adapterMock.capture.firstCall.args[0];
            assert.strictEqual(event.event, "feature_adoption");
            assert.strictEqual(event.properties.feature, "chat");
        });
    });
});
