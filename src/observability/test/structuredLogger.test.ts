import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { StructuredLogger } from "../structuredLogger";
import type { LogLevel } from "../types";

suite("StructuredLogger", () => {
    /**
     * Log level filtering is now handled by VS Code's LogOutputChannel UI
     * (the dropdown in the output panel). StructuredLogger.isEnabled() always
     * returns true because all logs are sent to the channel and the channel
     * decides what to display based on the user-selected level.
     */
    test("isEnabled always returns true (filtering handled by output channel UI)", () => {
        // Regardless of setLevel calls, isEnabled should always return true
        StructuredLogger.setLevel("info" as LogLevel);

        assert.strictEqual(StructuredLogger.isEnabled("trace" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("debug" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("info" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("warn" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("error" as LogLevel), true);
    });

    test("isEnabled returns true for all levels when set to trace", () => {
        StructuredLogger.setLevel("trace" as LogLevel);

        assert.strictEqual(StructuredLogger.isEnabled("trace" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("debug" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("info" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("warn" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("error" as LogLevel), true);
    });

    test("isEnabled returns true for all levels when set to error", () => {
        StructuredLogger.setLevel("error" as LogLevel);

        // All levels return true - output channel UI handles filtering
        assert.strictEqual(StructuredLogger.isEnabled("trace" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("debug" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("info" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("warn" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("error" as LogLevel), true);
    });

    test("initialize uses distinct structured logger output channel name", () => {
        const mockChannel = {
            trace: () => undefined,
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
            show: () => undefined,
            dispose: () => undefined,
        } as unknown as vscode.LogOutputChannel;

        const createOutputChannelStub = sinon.stub(vscode.window, "createOutputChannel").returns(mockChannel);

        const context: Partial<vscode.ExtensionContext> = { subscriptions: [] };

        StructuredLogger.initialize(context as vscode.ExtensionContext);

        assert.ok(createOutputChannelStub.calledOnce);
        assert.strictEqual(createOutputChannelStub.firstCall.args[0], "LiteLLM Structured");

        sinon.restore();
    });
});
