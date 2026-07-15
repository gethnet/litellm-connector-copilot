import * as assert from "assert";
import {
    EffortFallbackCache,
    hasShownReasoningFallbackNotification,
    isReasoningError,
    markReasoningFallbackNotified,
} from "../reasoningEffortFallback";
import type { SupportedReasoningEffort } from "../../types";

interface HttpErrorLike {
    status?: number;
    statusCode?: number;
    message?: string;
    body?: unknown;
}

suite("reasoningEffortFallback", () => {
    let cache: EffortFallbackCache;

    setup(() => {
        cache = new EffortFallbackCache();
    });

    test("getEffectiveEffort returns requested effort when there are no recorded failures", () => {
        const effort = cache.getEffectiveEffort("model-a", "high");
        assert.strictEqual(effort, "high");
    });

    test("recordFailure walks from max through every effort until the parameter is omitted", () => {
        let effort: SupportedReasoningEffort | undefined = "max";
        const expectedNext: (SupportedReasoningEffort | undefined)[] = [
            "xhigh",
            "high",
            "medium",
            "low",
            "minimal",
            "none",
            undefined,
        ];

        for (const expected of expectedNext) {
            const next = cache.recordFailure("model-a", effort);
            assert.strictEqual(next, expected);
            effort = next;
        }
    });

    test("getEffectiveEffort skips previously failed efforts", () => {
        cache.recordFailure("model-a", "high");
        cache.recordFailure("model-a", "medium");

        const adjusted = cache.getEffectiveEffort("model-a", "high");

        assert.strictEqual(adjusted, "low");
    });

    test("fallback decisions are isolated per model id", () => {
        cache.recordFailure("model-a", "high");

        const adjustedA = cache.getEffectiveEffort("model-a", "high");
        const adjustedB = cache.getEffectiveEffort("model-b", "high");

        assert.strictEqual(adjustedA, "medium");
        assert.strictEqual(adjustedB, "high");
    });

    suite("isReasoningError", () => {
        const buildError = (error: HttpErrorLike): unknown => error;

        test("returns true for a 400 error message mentioning reasoning tokens", () => {
            const error = buildError({
                status: 400,
                message: "reasoning_effort parameter unsupported",
            });

            assert.strictEqual(isReasoningError(error), true);
        });

        test("returns false for a 400 error without reasoning tokens", () => {
            const error = buildError({
                status: 400,
                message: "Bad request",
            });

            assert.strictEqual(isReasoningError(error), false);
        });

        test("returns false for non-4xx errors even when reasoning tokens appear", () => {
            const error = buildError({
                status: 500,
                message: "reasoning effort unavailable",
            });

            assert.strictEqual(isReasoningError(error), false);
        });

        test("returns true for a 422 body error message containing reasoning tokens", () => {
            const error = buildError({
                status: 422,
                body: { error: "Invalid parameter: reasoning_effort" },
            });

            assert.strictEqual(isReasoningError(error), true);
        });
    });

    test("clear resets cached failures", () => {
        cache.recordFailure("model-a", "high");
        assert.strictEqual(cache.getEffectiveEffort("model-a", "high"), "medium");

        cache.clear();

        assert.strictEqual(cache.getEffectiveEffort("model-a", "high"), "high");
    });

    suite("notification dedupe", () => {
        test("marking a notification prevents repeat", () => {
            const keyModel = "model-a";
            const effort = "high" as const;

            assert.strictEqual(hasShownReasoningFallbackNotification(keyModel, effort), false);

            markReasoningFallbackNotified(keyModel, effort);

            assert.strictEqual(hasShownReasoningFallbackNotification(keyModel, effort), true);
        });

        test("dedupe is scoped by model and effort", () => {
            const effort = "medium" as const;
            markReasoningFallbackNotified("model-a", effort);

            assert.strictEqual(hasShownReasoningFallbackNotification("model-b", effort), false);
        });
    });
});
