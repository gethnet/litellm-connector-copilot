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
        assert.strictEqual(event.properties.caller, "test-caller");
        assert.strictEqual(event.properties.model, "test-model");
        assert.strictEqual(event.properties.distinctId, "test-machine-id");
        assert.strictEqual(event.properties.extension_version, "1.0.0");
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

    test("should identify users", () => {
        telemetryService.identify("user-123", { email: "test@example.com" });
        assert.strictEqual(adapterMock.identify.calledWith("user-123", { email: "test@example.com" }), true);
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

    test("captureFeatureUsed sends correct event", () => {
        const mockContext = {
            extension: { packageJSON: { version: "1.0.0" } },
        } as unknown as vscode.ExtensionContext;
        telemetryService.initialize(mockContext);

        telemetryService.captureFeatureUsed("chat", "inline-edit");

        assert.strictEqual(adapterMock.capture.calledOnce, true);
        const event = adapterMock.capture.firstCall.args[0];
        assert.strictEqual(event.event, "feature_used");
        assert.strictEqual(event.properties.feature_name, "chat");
        assert.strictEqual(event.properties.caller, "inline-edit");
    });
});
