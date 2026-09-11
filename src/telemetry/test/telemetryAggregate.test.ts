import * as assert from "assert";
import { BoundedTelemetryAggregate } from "../telemetryAggregate";

suite("BoundedTelemetryAggregate", () => {
    test("empty drains emit nothing and repeated drains do not duplicate counts", () => {
        const aggregate = new BoundedTelemetryAggregate();
        assert.strictEqual(aggregate.isEmpty(), true);
        assert.deepStrictEqual(aggregate.drain(), []);
        aggregate.add({ modelId: "model", caller: "chat" });
        assert.strictEqual(aggregate.isEmpty(), false);
        assert.strictEqual(aggregate.drain()[0].request_count, 1);
        assert.deepStrictEqual(aggregate.drain(), []);
    });

    test("caps cardinality without early emission and keeps accurate overflow counts", () => {
        const aggregate = new BoundedTelemetryAggregate();
        for (let index = 0; index < 1_000; index += 1) {
            aggregate.add({ modelId: `model-${index}`, caller: "chat" });
        }
        aggregate.add({ modelId: "model-0", caller: "chat" });
        const rows = aggregate.drain();
        assert.strictEqual(rows.length, 129);
        assert.strictEqual(rows.find((row) => row.model_id === "model-0")?.request_count, 2);
        assert.strictEqual(rows.find((row) => row.overflow)?.request_count, 872);
        assert.strictEqual(
            rows.reduce((total, row) => total + row.request_count, 0),
            1_001
        );
        assert.deepStrictEqual(aggregate.drain(), []);
    });

    test("tuple serialization and overflow flags prevent identity collisions", () => {
        const aggregate = new BoundedTelemetryAggregate(3);
        aggregate.add({ modelId: "a\u0000b", caller: "c" });
        aggregate.add({ modelId: "a", caller: "b\u0000c" });
        aggregate.add({ modelId: "__overflow__", caller: "__overflow__" });
        aggregate.add({ modelId: "fourth", caller: "chat" });
        const rows = aggregate.drain();
        assert.strictEqual(rows.length, 4);
        assert.strictEqual(rows.filter((row) => row.overflow).length, 1);
        assert.strictEqual(rows.filter((row) => !row.overflow).length, 3);
    });

    test("preserves duration, token-weighted cache, and independent known costs", () => {
        const aggregate = new BoundedTelemetryAggregate();
        aggregate.add({
            modelId: "model",
            caller: "inline-completions",
            durationMs: 10,
            tokensIn: 100,
            tokensOut: 5,
            cacheReadRatio: 0.5,
            estimatedInputCost: 0,
            estimatedTotalCost: 0.2,
        });
        aggregate.add({
            modelId: "model",
            caller: "inline-completions",
            durationMs: 30,
            tokensIn: 300,
            tokensOut: 15,
            cacheReadRatio: 1,
            estimatedOutputCost: 0.1,
        });
        aggregate.add({ modelId: "model", caller: "inline-completions" });
        const [row] = aggregate.drain();
        assert.strictEqual(row.request_count, 3);
        assert.strictEqual(row.duration_count, 2);
        assert.strictEqual(row.duration_sum_ms, 40);
        assert.strictEqual(row.duration_max_ms, 30);
        assert.strictEqual(row.tokens_in, 400);
        assert.strictEqual(row.tokens_out, 20);
        assert.strictEqual(row.cache_ratio_numerator, 350);
        assert.strictEqual(row.cache_ratio_denominator, 400);
        assert.strictEqual(row.input_cost_count, 1);
        assert.strictEqual(row.input_cost_sum, 0);
        assert.strictEqual(row.output_cost_count, 1);
        assert.strictEqual(row.output_cost_sum, 0.1);
        assert.strictEqual(row.total_cost_count, 1);
        assert.strictEqual(row.total_cost_sum, 0.2);
        assert.strictEqual("request_id" in row, false);
        assert.strictEqual("p95" in row, false);
    });

    test("rejects invalid numeric inputs but retains valid zero observations", () => {
        const aggregate = new BoundedTelemetryAggregate();
        for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
            aggregate.add({
                modelId: "model",
                caller: "chat",
                durationMs: value,
                tokensIn: value,
                tokensOut: value,
                cacheReadRatio: value,
                estimatedInputCost: value,
                estimatedOutputCost: value,
                estimatedTotalCost: value,
            });
        }
        aggregate.add({ modelId: "model", caller: "chat", durationMs: 0, estimatedInputCost: 0 });
        const [row] = aggregate.drain();
        assert.strictEqual(row.request_count, 4);
        assert.strictEqual(row.duration_count, 1);
        assert.strictEqual(row.duration_sum_ms, 0);
        assert.strictEqual(row.tokens_in, 0);
        assert.strictEqual(row.tokens_out, 0);
        assert.strictEqual(row.cache_ratio_denominator, 0);
        assert.strictEqual(row.input_cost_count, 1);
        assert.strictEqual(row.output_cost_count, 0);
        assert.strictEqual(row.total_cost_count, 0);
    });
});
