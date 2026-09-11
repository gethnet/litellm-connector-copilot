import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { PostHogAdapter } from "../posthogAdapter";
import { TelemetryService } from "../telemetryService";

suite("Telemetry volume and lifecycle", () => {
    const interval = 15 * 60 * 1000;
    const context = {
        extension: { packageJSON: { version: "test-volume" } },
    } as unknown as vscode.ExtensionContext;
    let sandbox: sinon.SinonSandbox;
    let clock: sinon.SinonFakeTimers;
    let adapter: sinon.SinonStubbedInstance<PostHogAdapter>;
    let service: TelemetryService;
    let consent: vscode.EventEmitter<boolean>;
    let initialConsent: boolean;

    setup(() => {
        sandbox = sinon.createSandbox();
        clock = sandbox.useFakeTimers({ now: 1_000 });
        initialConsent = true;
        consent = new vscode.EventEmitter<boolean>();
        sandbox.stub(vscode.env, "isTelemetryEnabled").get(() => initialConsent);
        sandbox.stub(vscode.env, "machineId").get(() => "test-machine-id");
        sandbox.stub(vscode.env, "sessionId").get(() => "test-crash-reporter-id");
        sandbox.stub(vscode.env, "onDidChangeTelemetryEnabled").get(() => consent.event);
        adapter = sandbox.createStubInstance(PostHogAdapter);
        adapter.flush.resolves();
        adapter.shutdown.resolves();
        service = new TelemetryService();
        (service as unknown as { adapter: PostHogAdapter }).adapter = adapter;
    });

    teardown(async () => {
        await service.shutdown().catch(() => undefined);
        consent.dispose();
        sandbox.restore();
    });

    function completed(caller = "inline-completions") {
        return {
            request_id: "request",
            caller,
            model: "routing/vendor/model",
            endpoint: "/responses",
            durationMs: 10,
            tokensIn: 100,
            tokensOut: 5,
            cacheReadRatio: 0.5,
            cost: { estimated_input_cost: 0, estimated_output_cost: 0.1, estimated_total_cost: 0.1 },
        };
    }

    function collect(): void {
        service.captureModelUsed("routing/vendor/model", "inline-completions");
        service.captureRequestCompletedWithCache(completed());
        service.captureFeatureUsed("model-picker", "chat");
    }

    test("ten thousand inline successes emit two summaries, not thirty thousand events", () => {
        service.initialize(context);
        for (let index = 0; index < 10_000; index += 1) {
            service.captureModelUsed("routing/vendor/model", "inline-completions");
            service.captureRequestCompletedWithCache({ ...completed(), request_id: `request-${index}` });
        }
        assert.strictEqual(adapter.capture.callCount, 0);
        clock.tick(interval);
        assert.strictEqual(adapter.capture.callCount, 2);
        const [model, inline] = adapter.capture.getCalls().map((call) => call.args[0]);
        assert.strictEqual(model.event, "model_used_aggregated");
        assert.strictEqual(model.properties.attempt_count, 10_000);
        assert.strictEqual(model.properties.model_id, "routing/vendor/model");
        assert.strictEqual(inline.event, "inline_completion_aggregated");
        assert.strictEqual(inline.properties.request_count, 10_000);
        assert.strictEqual(inline.properties.duration_sum_ms, 100_000);
        assert.strictEqual(inline.properties.duration_count, 10_000);
        assert.strictEqual(inline.properties.duration_max_ms, 10);
        assert.strictEqual(inline.properties.tokens_in, 1_000_000);
        assert.strictEqual(inline.properties.tokens_out, 50_000);
        assert.strictEqual(inline.properties.cache_ratio_numerator, 500_000);
        assert.strictEqual(inline.properties.cache_ratio_denominator, 1_000_000);
        assert.strictEqual(inline.properties.input_cost_count, 10_000);
        assert.strictEqual(inline.properties.input_cost_sum, 0);
        assert.ok(Math.abs(Number(inline.properties.total_cost_sum) - 1_000) < 1e-6);
        assert.strictEqual(inline.properties.extension_version, "test-volume");
        assert.strictEqual(inline.properties.request_id, undefined);
        assert.strictEqual(inline.properties.p95, undefined);
        clock.tick(interval);
        assert.strictEqual(adapter.capture.callCount, 2);
    });

    test("both completion APIs aggregate inline successes and keep other callers immediate", () => {
        service.initialize(context);
        service.captureRequestCompleted(completed());
        service.captureRequestCompletedWithCache(completed());
        for (const caller of ["chat", "terminal-chat", "scm-generator", "unknown", ""]) {
            service.captureRequestCompletedWithCache(completed(caller));
        }
        service.captureRequestFailed({
            request_id: "failure",
            caller: "inline-completions",
            model: "model",
            endpoint: "/responses",
            durationMs: 2,
            errorType: "network",
        });
        assert.strictEqual(adapter.capture.callCount, 6);
        assert.strictEqual(adapter.capture.lastCall.args[0].event, "request_failed");
        clock.tick(interval);
        assert.strictEqual(adapter.capture.lastCall.args[0].properties.request_count, 2);
    });

    test("preinitialize and initially disabled paths neither buffer nor transmit", () => {
        collect();
        assert.strictEqual(clock.countTimers(), 0);
        initialConsent = false;
        service.initialize(context);
        collect();
        service.captureExtensionActivated("version", "vscode");
        service.captureException(new Error("disabled"));
        clock.tick(interval);
        assert.strictEqual(adapter.capture.callCount, 0);
        assert.strictEqual(adapter.captureException.callCount, 0);
        assert.strictEqual(clock.countTimers(), 0);
        consent.fire(true);
        clock.tick(interval);
        assert.strictEqual(adapter.capture.callCount, 0);
        collect();
        clock.tick(interval);
        assert.strictEqual(adapter.capture.callCount, 3);
    });

    test("consent revocation drops every pending aggregate and starts a fresh enabled window", () => {
        service.initialize(context);
        collect();
        clock.tick(500);
        consent.fire(false);
        collect();
        clock.tick(interval);
        assert.strictEqual(adapter.capture.callCount, 0);
        assert.strictEqual(clock.countTimers(), 0);
        consent.fire(true);
        const started = Date.now();
        collect();
        clock.tick(interval);
        const rows = adapter.capture.getCalls().map((call) => call.args[0]);
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows[0].properties.attempt_count, 1);
        assert.strictEqual(rows[1].properties.request_count, 1);
        assert.strictEqual(rows[0].properties.window_started_at_ms, started);
        assert.strictEqual(rows[0].properties.window_duration_ms, interval);
        assert.deepStrictEqual(JSON.parse(String(rows[2].properties.features)), { "model-picker": 1 });
        assert.strictEqual(adapter.setEnabled.calledWith(false), true);
        assert.strictEqual(adapter.setEnabled.calledWith(true), true);
    });

    for (const disposeFirst of [true, false]) {
        test(`partial flush is accurate and cleanup is idempotent: disposeFirst=${disposeFirst}`, async () => {
            service.initialize(context);
            service.initialize(context);
            assert.strictEqual(clock.countTimers(), 1);
            collect();
            clock.tick(60_000);
            if (disposeFirst) {
                service.dispose();
            }
            await service.shutdown();
            service.dispose();
            await service.shutdown();
            assert.strictEqual(adapter.capture.callCount, 3);
            assert.strictEqual(adapter.capture.firstCall.args[0].properties.period_minutes, 1);
            assert.strictEqual(adapter.capture.firstCall.args[0].properties.window_duration_ms, 60_000);
            assert.strictEqual(adapter.flush.callCount, 1);
            assert.strictEqual(adapter.shutdown.callCount, 1);
            assert.strictEqual(clock.countTimers(), 0);
            collect();
            consent.fire(true);
            service.initialize(context);
            service.captureExtensionActivated("late", "late");
            service.captureException(new Error("late"));
            clock.tick(interval);
            assert.strictEqual(adapter.capture.callCount, 3);
            assert.strictEqual(adapter.captureException.callCount, 0);
            assert.strictEqual(clock.countTimers(), 0);
        });
    }

    test("service overflow remains bounded and conserves both attempt and success totals", () => {
        service.initialize(context);
        for (let index = 0; index < 1_000; index += 1) {
            const model = `model-${index}`;
            service.captureModelUsed(model, "inline-completions");
            service.captureRequestCompleted({ ...completed(), model });
        }
        assert.strictEqual(adapter.capture.callCount, 0);
        clock.tick(interval);
        const rows = adapter.capture.getCalls().map((call) => call.args[0]);
        assert.strictEqual(rows.length, 258);
        const attempts = rows.filter((row) => row.event === "model_used_aggregated");
        const successes = rows.filter((row) => row.event === "inline_completion_aggregated");
        assert.strictEqual(
            attempts.reduce((sum, row) => sum + Number(row.properties.attempt_count), 0),
            1_000
        );
        assert.strictEqual(
            successes.reduce((sum, row) => sum + Number(row.properties.request_count), 0),
            1_000
        );
    });

    test("shutdown still closes adapter after flush rejects and ignores late timer work", async () => {
        service.initialize(context);
        collect();
        adapter.flush.rejects(new Error("flush failed"));
        await assert.rejects(() => service.shutdown(), /flush failed/);
        assert.strictEqual(adapter.shutdown.callCount, 1);
        clock.tick(interval);
        assert.strictEqual(adapter.capture.callCount, 3);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test("synchronous capture failure cannot prevent disposal cleanup", async () => {
        service.initialize(context);
        collect();
        adapter.capture.throws(new Error("capture failed"));
        await service.shutdown();
        assert.strictEqual(adapter.shutdown.callCount, 1);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test("activation contains static features without separate adoption events", () => {
        service.initialize(context);
        service.captureExtensionActivated("version", "vscode", ["chat", "commit-generation", "model-picker"]);
        assert.strictEqual(adapter.capture.callCount, 1);
        assert.strictEqual(adapter.capture.firstCall.args[0].event, "extension_activated");
        assert.deepStrictEqual(adapter.capture.firstCall.args[0].properties.feature_adoption, [
            "chat",
            "commit-generation",
            "model-picker",
        ]);
    });
});
