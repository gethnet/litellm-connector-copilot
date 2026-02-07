import * as assert from "assert";
import * as sinon from "sinon";
import { LiteLLMTelemetry, IMetrics } from "../../utils/telemetry";
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
});
