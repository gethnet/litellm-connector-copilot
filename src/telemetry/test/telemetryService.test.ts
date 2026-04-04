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
});
