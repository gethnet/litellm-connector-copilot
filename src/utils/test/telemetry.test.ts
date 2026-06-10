import * as assert from "assert";
import * as sinon from "sinon";
import type { IMetrics } from "..//telemetry";
import { LiteLLMTelemetry } from "..//telemetry";
import { Logger } from "..//logger";
import type { TelemetryService } from "../../telemetry/telemetryService";

/**
 * Sinon's `args[0]` is typed as `any`, which trips no-unsafe-* lint rules
 * even when we cast at the call site. Wrapping the read in a typed helper
 * narrows the value once and lets every call site stay clean of `any`.
 */
function firstArg<T>(stub: sinon.SinonStub): T {
    const value: unknown = stub.firstCall.args[0];
    return value as T;
}

suite("Telemetry Unit Tests", () => {
    let loggerDebugStub: sinon.SinonStub;
    let loggerInfoStub: sinon.SinonStub;
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        loggerDebugStub = sandbox.stub(Logger, "debug");
        loggerInfoStub = sandbox.stub(Logger, "info");
        LiteLLMTelemetry.setTelemetryService(undefined as unknown as TelemetryService);
    });

    teardown(() => {
        LiteLLMTelemetry.setTelemetryService(undefined as unknown as TelemetryService);
        sandbox.restore();
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
        const logMessage = firstArg<string>(loggerDebugStub);
        assert.ok(logMessage.includes("[Telemetry]"));
        assert.ok(logMessage.includes('"requestId":"123"'));
        assert.ok(loggerInfoStub.calledOnce);
        const infoMessage = firstArg<string>(loggerInfoStub);
        assert.ok(infoMessage.includes("[TokenUsage]"));
        assert.ok(infoMessage.includes("tokens_in=0"));
        assert.ok(infoMessage.includes("tokens_out=0"));
        assert.ok(infoMessage.includes("token_count_max=n/a"));
        assert.ok(infoMessage.includes("total_token_max=n/a"));
    });

    test("IMetrics interface includes cacheReadRatio field", () => {
        const metric: IMetrics = {
            requestId: "999",
            model: "gpt-4-turbo",
            tokensIn: 1000,
            tokensOut: 500,
            cacheReadRatio: 0.35, // 35% cache hit ratio
            status: "success",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.calledOnce);
        const logMessage = firstArg<string>(loggerDebugStub);
        assert.ok(logMessage.includes('"cacheReadRatio":0.35'));
    });

    test("cacheReadRatio is undefined when not provided", () => {
        const metric: IMetrics = {
            requestId: "888",
            model: "claude-3",
            tokensIn: 200,
            tokensOut: 100,
            status: "success",
        };

        LiteLLMTelemetry.reportMetric(metric);

        assert.ok(loggerDebugStub.calledOnce);
        const logMessage = firstArg<string>(loggerDebugStub);
        // Ensure cacheReadRatio is not falsey but undefined, and doesn't appear in debug log
        assert.ok(!logMessage.includes('"cacheReadRatio"'));
    });

    test("captureRequestCompletedWithCache passes cacheReadRatio to capture method", () => {
        const captureRequestCompletedWithCache = sandbox.stub();
        const captureRequestFailed = sandbox.stub();
        const captureRequestCachingBypassed = sandbox.stub();
        const telemetryServiceStub = {
            captureRequestCompletedWithCache,
            captureRequestFailed,
            captureRequestCachingBypassed,
        } as unknown as TelemetryService;

        LiteLLMTelemetry.setTelemetryService(telemetryServiceStub);

        const customProps: IMetrics = {
            requestId: "custom-req-123",
            caller: "inline-completions",
            model: "gpt-4",
            durationMs: 120,
            tokensIn: 800,
            tokensOut: 400,
            cacheReadRatio: 0.25,
            status: "success",
        };

        LiteLLMTelemetry.reportMetric(customProps);

        assert.strictEqual(loggerInfoStub.calledOnce, true);
        assert.strictEqual(captureRequestCompletedWithCache.calledOnce, true);
        interface CompletedWithCacheProps {
            cacheReadRatio?: number;
        }
        const props = firstArg<CompletedWithCacheProps>(captureRequestCompletedWithCache);
        assert.strictEqual(props.cacheReadRatio, 0.25);
        assert.strictEqual(captureRequestFailed.called, false);
        assert.strictEqual(captureRequestCachingBypassed.called, false);
    });

    test("captureRequestCompletedWithCache omits cacheReadRatio when undefined", () => {
        const captureRequestCompletedWithCache = sandbox.stub();
        const telemetryServiceStub = {
            captureRequestCompletedWithCache,
            captureRequestFailed: sandbox.stub(),
            captureRequestCachingBypassed: sandbox.stub(),
        } as unknown as TelemetryService;

        LiteLLMTelemetry.setTelemetryService(telemetryServiceStub);

        const customProps: IMetrics = {
            requestId: "custom-req-456",
            caller: "terminal-chat",
            model: "gpt-4",
            durationMs: 90,
            tokensIn: 600,
            tokensOut: 300,
            cacheReadRatio: undefined,
            status: "success",
        };

        LiteLLMTelemetry.reportMetric(customProps);

        assert.strictEqual(captureRequestCompletedWithCache.calledOnce, true);
        interface CompletedWithCacheProps {
            cacheReadRatio?: number;
        }
        const props = firstArg<CompletedWithCacheProps>(captureRequestCompletedWithCache);
        assert.strictEqual(props.cacheReadRatio, undefined);
    });

    test("reportMetric forwards caching_bypassed status to captureRequestCachingBypassed", () => {
        const captureRequestCachingBypassed = sandbox.stub();
        const telemetryServiceStub = {
            captureRequestCompletedWithCache: sandbox.stub(),
            captureRequestFailed: sandbox.stub(),
            captureRequestCachingBypassed,
        } as unknown as TelemetryService;

        LiteLLMTelemetry.setTelemetryService(telemetryServiceStub);

        LiteLLMTelemetry.reportMetric({
            requestId: "req-cache-bypass-123",
            model: "anthropic/claude-3",
            status: "caching_bypassed",
            caller: "chat",
            error: "provider_caching_not_supported",
        });

        assert.strictEqual(captureRequestCachingBypassed.calledOnce, true);
        interface CachingBypassedProps {
            request_id: string;
            caller: string;
            model: string;
            endpoint: string;
            reason?: string;
        }
        const props = firstArg<CachingBypassedProps>(captureRequestCachingBypassed);
        assert.strictEqual(props.request_id, "req-cache-bypass-123");
        assert.strictEqual(props.caller, "chat");
        assert.strictEqual(props.endpoint, "unknown");
        assert.strictEqual(props.reason, "provider_caching_not_supported");
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
        const logMessage = firstArg<string>(loggerDebugStub);
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
        const logMessage = firstArg<string>(loggerDebugStub);
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
            const logMessage = firstArg<string>(loggerDebugStub);
            assert.ok(logMessage.includes(`"caller":"${caller}"`), `Should log caller: ${caller}`);
        }
    });

    test("reportMetric forwards requestId to captureRequestFailed", () => {
        const captureRequestFailed = sandbox.stub();
        const telemetryServiceStub = {
            captureRequestFailed,
            captureRequestCompletedWithCache: sandbox.stub(),
            captureRequestCachingBypassed: sandbox.stub(),
        } as unknown as TelemetryService;

        LiteLLMTelemetry.setTelemetryService(telemetryServiceStub);

        LiteLLMTelemetry.reportMetric({
            requestId: "req-metric-fail-123",
            model: "gpt-4",
            durationMs: 50,
            status: "failure",
            error: "network_error",
            caller: "chat",
        });

        assert.strictEqual(captureRequestFailed.calledOnce, true);
        interface CapturedFailureProps {
            request_id: string;
            caller: string;
            model: string;
            endpoint: string;
            durationMs: number;
            errorType: string;
        }
        const props = firstArg<CapturedFailureProps>(captureRequestFailed);
        assert.strictEqual(props.request_id, "req-metric-fail-123");
        assert.strictEqual(props.caller, "chat");
        assert.strictEqual(props.errorType, "network_error");
    });
});
