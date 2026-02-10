import * as assert from "assert";
import * as sinon from "sinon";
import type { IMetrics } from "../../utils/telemetry";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { Logger } from "../../utils/logger";

suite("Telemetry Unit Tests", () => {
    let loggerDebugStub: sinon.SinonStub;

    setup(() => {
        loggerDebugStub = sinon.stub(Logger, "debug");
    });

    teardown(() => {
        sinon.restore();
    });

    test("reportMetric logs to Logger.debug", () => {
        const metric: IMetrics = {
            requestId: "123",
            model: "gpt-4",
            durationMs: 100,
            status: "success",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.calledOnce);
        const logMessage = loggerDebugStub.firstCall.args[0];
        assert.ok(logMessage.includes("[Telemetry]"));
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

        assert.ok(loggerDebugStub.calledOnce);
        const logMessage = loggerDebugStub.firstCall.args[0];
        assert.ok(logMessage.includes("[Telemetry]"));
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

        assert.ok(loggerDebugStub.calledOnce);
        const logMessage = loggerDebugStub.firstCall.args[0];
        assert.ok(logMessage.includes("[Telemetry]"));
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

            assert.ok(loggerDebugStub.calledOnce);
            const logMessage = loggerDebugStub.firstCall.args[0];
            assert.ok(logMessage.includes(`"caller":"${caller}"`), `Should log caller: ${caller}`);
        }
    });
});
