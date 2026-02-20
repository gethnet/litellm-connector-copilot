import * as assert from "assert";
import * as sinon from "sinon";
import type { IMetrics } from "../../utils/telemetry";
import { BatchingBackend, LiteLLMTelemetry } from "../../utils/telemetry";
import { Logger } from "../../utils/logger";

suite("Telemetry Unit Tests", () => {
    let loggerDebugStub: sinon.SinonStub;

    setup(() => {
        loggerDebugStub = sinon.stub(Logger, "debug");
    });

    teardown(() => {
        sinon.restore();
    });

    test("reportEvent logs Telemetry-Mock when backend is unset", () => {
        LiteLLMTelemetry.reportEvent("some.event", { a: 1 });

        assert.ok(loggerDebugStub.called);
        const logMessage = loggerDebugStub.getCalls().find((c) => c.args[0].includes("[Telemetry-Mock]"))?.args[0];
        assert.ok(logMessage, "Should find [Telemetry-Mock] log message");
        assert.ok(logMessage.includes("some.event"));
    });

    test("logger.warn sampling suppresses repeats within interval", () => {
        // Ensure we are in mock mode so we can observe Logger.debug output.
        LiteLLMTelemetry.reportEvent("logger.warn", { message: "warn-1" });
        LiteLLMTelemetry.reportEvent("logger.warn", { message: "warn-1" });

        const warnLogs = loggerDebugStub.getCalls().filter((c) => String(c.args[0]).includes("logger.warn"));
        assert.strictEqual(warnLogs.length, 1, "Second warn should be sampled out");
    });

    test("BatchingBackend flushes on shutdown", async () => {
        const emitted: string[] = [];
        const inner = {
            emit: async (e: { name: string }) => {
                emitted.push(e.name);
            },
            shutdown: async () => {},
        };

        const backend = new BatchingBackend(inner);
        await backend.emit({ name: "e1", properties: {} });
        await backend.emit({ name: "e2", properties: {} });
        assert.deepStrictEqual(emitted, [], "Should not flush immediately under threshold");

        await backend.shutdown();
        assert.deepStrictEqual(emitted.sort(), ["e1", "e2"], "Shutdown should flush queued events");
    });

    test("reportMetric logs to Logger.debug", () => {
        const metric: IMetrics = {
            requestId: "123",
            model: "gpt-4",
            durationMs: 100,
            status: "success",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.called);
        const logMessage = loggerDebugStub.getCalls().find((c) => c.args[0].includes("[Telemetry]"))?.args[0];
        assert.ok(logMessage, "Should find [Telemetry] log message");
        assert.ok(logMessage.includes('"requestId":"123"'));
    });

    test("Timer methods return numbers", () => {
        const start = LiteLLMTelemetry.startTimer();
        assert.strictEqual(typeof start, "number");

        const duration = LiteLLMTelemetry.endTimer(start);
        assert.strictEqual(typeof duration, "number");
        assert.ok(duration >= 0);
    });

    test("reportMetric includes caller context when provided", () => {
        const metric: IMetrics = {
            requestId: "123",
            model: "gpt-4",
            durationMs: 100,
            status: "success",
            caller: "inline-edit",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.called);
        const logMessage = loggerDebugStub.getCalls().find((c) => c.args[0].includes("[Telemetry]"))?.args[0];
        assert.ok(logMessage, "Should find [Telemetry] log message");
        assert.ok(logMessage.includes('"caller":"inline-edit"'));
    });

    test("reportMetric handles metrics without caller", () => {
        const metric: IMetrics = {
            requestId: "456",
            model: "claude-3",
            status: "failure",
            error: "timeout",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.called);
        const logMessage = loggerDebugStub.getCalls().find((c) => c.args[0].includes("[Telemetry]"))?.args[0];
        assert.ok(logMessage, "Should find [Telemetry] log message");
        assert.ok(logMessage.includes('"status":"failure"'));
    });

    test("reportMetric logs different caller contexts", () => {
        const callers = ["scm-generator", "terminal-chat", "inline-completions"];

        for (const caller of callers) {
            loggerDebugStub.resetHistory();

            const metric: IMetrics = {
                requestId: "test-" + caller,
                model: "gpt-4",
                status: "success",
                caller,
            };

            LiteLLMTelemetry.reportMetric(metric);

            assert.ok(loggerDebugStub.called);
            const logMessage = loggerDebugStub.getCalls().find((c) => c.args[0].includes("[Telemetry]"))?.args[0];
            assert.ok(logMessage, "Should find [Telemetry] log message");
            assert.ok(logMessage.includes(`"caller":"${caller}"`), `Should log caller: ${caller}`);
        }
    });
});
