import * as assert from "assert";
import {
    extractPricing,
    formatPricingForDetail,
    formatPricingForTooltip,
    calculateRequestCost,
    derivePriceCategory,
} from "../pricingCalculator";
import type { LiteLLMModelInfo } from "../../types";

suite("pricingCalculator", () => {
    suite("extractPricing", () => {
        test("extracts per-token pricing fields from model info", () => {
            const modelInfo: LiteLLMModelInfo = {
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.000005,
            };
            const pricing = extractPricing(modelInfo);
            assert.strictEqual(pricing?.inputCostPerToken, 0.000001);
            assert.strictEqual(pricing?.outputCostPerToken, 0.000005);
        });

        test("returns undefined when no pricing fields present", () => {
            const modelInfo: LiteLLMModelInfo = {
                litellm_provider: "openai",
                max_tokens: 4096,
            };
            const pricing = extractPricing(modelInfo);
            assert.strictEqual(pricing, undefined);
        });

        test("returns undefined when pricing fields are null", () => {
            const modelInfo: LiteLLMModelInfo = {
                input_cost_per_token: null,
                output_cost_per_token: null,
            };
            const pricing = extractPricing(modelInfo);
            assert.strictEqual(pricing, undefined);
        });

        test("returns partial pricing when only input cost is present", () => {
            const modelInfo: LiteLLMModelInfo = {
                input_cost_per_token: 0.000002,
                output_cost_per_token: null,
            };
            const pricing = extractPricing(modelInfo);
            assert.strictEqual(pricing?.inputCostPerToken, 0.000002);
            assert.strictEqual(pricing?.outputCostPerToken, undefined);
        });

        test("handles cache read and creation costs", () => {
            const modelInfo: LiteLLMModelInfo = {
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.000005,
                cache_read_input_token_cost: 0.0000001,
                cache_creation_input_token_cost: 0.00000125,
            };
            const pricing = extractPricing(modelInfo);
            assert.strictEqual(pricing?.cacheReadCostPerToken, 0.0000001);
            assert.strictEqual(pricing?.cacheCreationCostPerToken, 0.00000125);
        });

        test("extracts pricing fields expressed in scientific notation", () => {
            // LiteLLM returns very small per-token costs in scientific notation
            // (e.g. 1e-7, 5e-9, 4.0000000000000003e-7). These are valid JSON
            // numbers and JavaScript Number handles them natively, but we test
            // explicitly to guard against any future type-coercion regressions.
            const modelInfo: LiteLLMModelInfo = {
                input_cost_per_token: 1e-7,
                output_cost_per_token: 5e-9,
                cache_read_input_token_cost: 5e-9,
                cache_creation_input_token_cost: 1.25e-7,
            };
            const pricing = extractPricing(modelInfo);
            assert.strictEqual(pricing?.inputCostPerToken, 1e-7);
            assert.strictEqual(pricing?.outputCostPerToken, 5e-9);
            assert.strictEqual(pricing?.cacheReadCostPerToken, 5e-9);
            assert.strictEqual(pricing?.cacheCreationCostPerToken, 1.25e-7);
        });

        test("extracts pricing with IEEE 754 floating-point artifact values", () => {
            // LiteLLM sometimes returns values like 4.0000000000000003e-7
            // which are IEEE 754 representation artifacts. These should pass
            // through unchanged — they are valid finite numbers.
            const modelInfo: LiteLLMModelInfo = {
                input_cost_per_token: 4.0000000000000003e-7,
                output_cost_per_token: 8.000000000000001e-7,
            };
            const pricing = extractPricing(modelInfo);
            assert.strictEqual(pricing?.inputCostPerToken, 4.0000000000000003e-7);
            assert.strictEqual(pricing?.outputCostPerToken, 8.000000000000001e-7);
        });
    });

    suite("formatPricingForDetail", () => {
        test("formats pricing as $X/1M inp • $Y/1M out", () => {
            const pricing = {
                inputCostPerToken: 0.000001,
                outputCostPerToken: 0.000005,
            };
            const formatted = formatPricingForDetail(pricing);
            assert.strictEqual(formatted, "$1.00/1M inp • $5.00/1M out");
        });

        test("returns empty string when pricing is undefined", () => {
            const formatted = formatPricingForDetail(undefined);
            assert.strictEqual(formatted, "");
        });

        test("handles partial pricing (only input)", () => {
            const pricing = {
                inputCostPerToken: 0.000001,
                outputCostPerToken: undefined,
            };
            const formatted = formatPricingForDetail(pricing);
            assert.strictEqual(formatted, "$1.00/1M inp");
        });

        test("handles partial pricing (only output)", () => {
            const pricing = {
                inputCostPerToken: undefined,
                outputCostPerToken: 0.000005,
            };
            const formatted = formatPricingForDetail(pricing);
            assert.strictEqual(formatted, "$5.00/1M out");
        });

        test("formats very small costs with appropriate precision", () => {
            const pricing = {
                inputCostPerToken: 0.0000001,
                outputCostPerToken: 0.0000001,
            };
            const formatted = formatPricingForDetail(pricing);
            assert.strictEqual(formatted, "$0.10/1M inp • $0.10/1M out");
        });

        test("formats scientific notation values (1e-7 → $0.10/1M)", () => {
            const pricing = {
                inputCostPerToken: 1e-7,
                outputCostPerToken: 4e-7,
            };
            const formatted = formatPricingForDetail(pricing);
            // 1e-7 * 1M = 0.1 (with FP artifact: 0.09999999999999999 → toFixed(2) = "0.10")
            // 4e-7 * 1M = 0.4 (with FP artifact: 0.39999999999999997 → toFixed(2) = "0.40")
            assert.strictEqual(formatted, "$0.10/1M inp • $0.40/1M out");
        });

        test("formats extremely small scientific notation values (5e-9 → $0.0050/1M)", () => {
            const pricing = {
                inputCostPerToken: 5e-9,
                outputCostPerToken: 2.5e-8,
            };
            const formatted = formatPricingForDetail(pricing);
            // 5e-9 * 1M = 0.005 → 4 decimal places
            // 2.5e-8 * 1M = 0.025 → 4 decimal places (with FP: 0.024999999999999998)
            assert.strictEqual(formatted, "$0.0050/1M inp • $0.0250/1M out");
        });

        test("formats IEEE 754 artifact values (4.0000000000000003e-7 → $0.40/1M)", () => {
            const pricing = {
                inputCostPerToken: 4.0000000000000003e-7,
                outputCostPerToken: 8.000000000000001e-7,
            };
            const formatted = formatPricingForDetail(pricing);
            // 4.0000000000000003e-7 * 1M = 0.4 (the FP artifact resolves to exactly 0.4)
            // 8.000000000000001e-7 * 1M = 0.8000000000000001 → toFixed(2) = "0.80"
            assert.strictEqual(formatted, "$0.40/1M inp • $0.80/1M out");
        });

        test("formats sub-nano-cent values with 6 decimal places (1e-10 → $0.0001/1M)", () => {
            const pricing = {
                inputCostPerToken: 1e-10,
            };
            const formatted = formatPricingForDetail(pricing);
            // 1e-10 * 1M = 0.0001 → 6 decimal places would show $0.000100
            // but 4 decimal places shows $0.0001 which is precise enough
            assert.strictEqual(formatted, "$0.0001/1M inp");
        });
    });

    suite("formatPricingForTooltip", () => {
        test("formats full pricing breakdown for tooltip including cache costs", () => {
            const pricing = {
                inputCostPerToken: 0.000001,
                outputCostPerToken: 0.000005,
                cacheReadCostPerToken: 0.0000001,
                cacheCreationCostPerToken: 0.00000125,
            };
            const formatted = formatPricingForTooltip(pricing);
            assert.ok(formatted.includes("Input: $1.00/1M tokens"));
            assert.ok(formatted.includes("Output: $5.00/1M tokens"));
            assert.ok(formatted.includes("Cache read: $0.10/1M tokens"));
            assert.ok(formatted.includes("Cache write: $1.25/1M tokens"));
        });

        test("returns empty string when pricing is undefined", () => {
            const formatted = formatPricingForTooltip(undefined);
            assert.strictEqual(formatted, "");
        });

        test("omits cache costs when not present", () => {
            const pricing = {
                inputCostPerToken: 0.000001,
                outputCostPerToken: 0.000005,
            };
            const formatted = formatPricingForTooltip(pricing);
            assert.ok(formatted.includes("Input: $1.00/1M tokens"));
            assert.ok(formatted.includes("Output: $5.00/1M tokens"));
            assert.ok(!formatted.includes("Cache"));
        });

        test("formats scientific notation cache costs correctly", () => {
            const pricing = {
                inputCostPerToken: 1e-7,
                outputCostPerToken: 5e-9,
                cacheReadCostPerToken: 5e-9,
                cacheCreationCostPerToken: 1.25e-7,
            };
            const formatted = formatPricingForTooltip(pricing);
            // 1e-7 * 1M = 0.10, 5e-9 * 1M = 0.0050, 1.25e-7 * 1M = 0.1250
            assert.ok(formatted.includes("Input: $0.10/1M tokens"), `got: ${formatted}`);
            assert.ok(formatted.includes("Output: $0.0050/1M tokens"), `got: ${formatted}`);
            assert.ok(formatted.includes("Cache read: $0.0050/1M tokens"), `got: ${formatted}`);
            assert.ok(formatted.includes("Cache write: $0.1250/1M tokens"), `got: ${formatted}`);
        });
    });

    suite("calculateRequestCost", () => {
        test("calculates cost from token counts and per-token pricing", () => {
            const pricing = {
                inputCostPerToken: 0.000001,
                outputCostPerToken: 0.000005,
            };
            const cost = calculateRequestCost({
                promptTokens: 1000,
                completionTokens: 500,
                cachedTokens: 0,
                cacheCreationInputTokens: 0,
                pricing,
            });
            // 1000 * 0.000001 + 500 * 0.000005 = 0.001 + 0.0025 = 0.0035
            assert.strictEqual(cost.totalCost, 0.0035);
            assert.strictEqual(cost.inputCost, 0.001);
            assert.strictEqual(cost.outputCost, 0.0025);
        });

        test("applies cache read pricing for cached tokens", () => {
            const pricing = {
                inputCostPerToken: 0.000001,
                outputCostPerToken: 0.000005,
                cacheReadCostPerToken: 0.0000001,
            };
            const cost = calculateRequestCost({
                promptTokens: 1000,
                completionTokens: 500,
                cachedTokens: 200,
                cacheCreationInputTokens: 0,
                pricing,
            });
            // Non-cached input: (1000 - 200) * 0.000001 = 0.0008
            // Cached input: 200 * 0.0000001 = 0.00002
            // Output: 500 * 0.000005 = 0.0025
            // Total: 0.0008 + 0.00002 + 0.0025 = 0.00332
            assert.strictEqual(cost.inputCost, 0.00082);
            assert.strictEqual(cost.outputCost, 0.0025);
            assert.strictEqual(cost.totalCost, 0.00332);
        });

        test("applies cache creation pricing for cache creation tokens", () => {
            const pricing = {
                inputCostPerToken: 0.000001,
                outputCostPerToken: 0.000005,
                cacheCreationCostPerToken: 0.00000125,
            };
            const cost = calculateRequestCost({
                promptTokens: 1000,
                completionTokens: 500,
                cachedTokens: 0,
                cacheCreationInputTokens: 100,
                pricing,
            });
            // Non-cached input: (1000 - 0 - 100) * 0.000001 = 0.0009
            // Cache creation: 100 * 0.00000125 = 0.000125
            // Output: 500 * 0.000005 = 0.0025
            // Total: 0.0009 + 0.000125 + 0.0025 = 0.003525
            assert.ok(Math.abs(cost.inputCost - 0.001025) < 1e-9);
            assert.ok(Math.abs(cost.outputCost - 0.0025) < 1e-9);
            assert.ok(Math.abs(cost.totalCost - 0.003525) < 1e-9);
        });

        test("returns zero costs when pricing is undefined", () => {
            const cost = calculateRequestCost({
                promptTokens: 1000,
                completionTokens: 500,
                cachedTokens: 0,
                cacheCreationInputTokens: 0,
                pricing: undefined,
            });
            assert.strictEqual(cost.totalCost, 0);
            assert.strictEqual(cost.inputCost, 0);
            assert.strictEqual(cost.outputCost, 0);
        });

        test("handles zero token counts", () => {
            const pricing = {
                inputCostPerToken: 0.000001,
                outputCostPerToken: 0.000005,
            };
            const cost = calculateRequestCost({
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
                cacheCreationInputTokens: 0,
                pricing,
            });
            assert.strictEqual(cost.totalCost, 0);
        });

        test("handles missing output pricing (output cost is 0)", () => {
            const pricing = {
                inputCostPerToken: 0.000001,
                outputCostPerToken: undefined,
            };
            const cost = calculateRequestCost({
                promptTokens: 1000,
                completionTokens: 500,
                cachedTokens: 0,
                cacheCreationInputTokens: 0,
                pricing,
            });
            assert.strictEqual(cost.inputCost, 0.001);
            assert.strictEqual(cost.outputCost, 0);
            assert.strictEqual(cost.totalCost, 0.001);
        });

        test("calculates cost with scientific notation pricing (1e-7 per token)", () => {
            const pricing = {
                inputCostPerToken: 1e-7,
                outputCostPerToken: 5e-9,
            };
            const cost = calculateRequestCost({
                promptTokens: 1_000_000,
                completionTokens: 500_000,
                cachedTokens: 0,
                cacheCreationInputTokens: 0,
                pricing,
            });
            // 1M * 1e-7 = 0.1, 500K * 5e-9 = 0.0025
            // Total = 0.1025
            assert.ok(Math.abs(cost.inputCost - 0.1) < 1e-9);
            assert.ok(Math.abs(cost.outputCost - 0.0025) < 1e-9);
            assert.ok(Math.abs(cost.totalCost - 0.1025) < 1e-9);
        });

        test("calculates cost with extremely small scientific notation (5e-9 per token)", () => {
            const pricing = {
                inputCostPerToken: 5e-9,
                outputCostPerToken: 5e-9,
            };
            const cost = calculateRequestCost({
                promptTokens: 10_000_000,
                completionTokens: 5_000_000,
                cachedTokens: 0,
                cacheCreationInputTokens: 0,
                pricing,
            });
            // 10M * 5e-9 = 0.05, 5M * 5e-9 = 0.025
            // Total = 0.075
            assert.ok(Math.abs(cost.inputCost - 0.05) < 1e-9);
            assert.ok(Math.abs(cost.outputCost - 0.025) < 1e-9);
            assert.ok(Math.abs(cost.totalCost - 0.075) < 1e-9);
        });

        test("calculates cost with IEEE 754 artifact pricing values", () => {
            const pricing = {
                inputCostPerToken: 4.0000000000000003e-7,
                outputCostPerToken: 8.000000000000001e-7,
            };
            const cost = calculateRequestCost({
                promptTokens: 1000,
                completionTokens: 500,
                cachedTokens: 0,
                cacheCreationInputTokens: 0,
                pricing,
            });
            // The FP artifacts are tiny and don't affect the result at this scale
            // 1000 * 4.0000000000000003e-7 ≈ 0.0004, 500 * 8.000000000000001e-7 ≈ 0.0004
            // Use approx equality to handle FP variance
            assert.ok(Math.abs(cost.inputCost - 0.0004) < 1e-12, `inputCost ${cost.inputCost} should be ≈ 0.0004`);
            assert.ok(Math.abs(cost.outputCost - 0.0004) < 1e-12, `outputCost ${cost.outputCost} should be ≈ 0.0004`);
            assert.ok(Math.abs(cost.totalCost - 0.0008) < 1e-12, `totalCost ${cost.totalCost} should be ≈ 0.0008`);
        });

        test("calculates cost with scientific notation cache pricing", () => {
            const pricing = {
                inputCostPerToken: 1e-7,
                outputCostPerToken: 5e-9,
                cacheReadCostPerToken: 5e-9,
                cacheCreationCostPerToken: 1.25e-7,
            };
            const cost = calculateRequestCost({
                promptTokens: 1_000_000,
                completionTokens: 500_000,
                cachedTokens: 200_000,
                cacheCreationInputTokens: 100_000,
                pricing,
            });
            // Standard input: (1M - 200K - 100K) * 1e-7 = 700K * 1e-7 = 0.07
            // Cached input: 200K * 5e-9 = 0.001
            // Cache creation: 100K * 1.25e-7 = 0.0125
            // Input cost: 0.07 + 0.001 + 0.0125 = 0.0835
            // Output: 500K * 5e-9 = 0.0025
            // Total: 0.0835 + 0.0025 = 0.086
            assert.ok(Math.abs(cost.inputCost - 0.0835) < 1e-12, `inputCost ${cost.inputCost} should be ≈ 0.0835`);
            assert.strictEqual(cost.outputCost, 0.0025);
            assert.ok(Math.abs(cost.totalCost - 0.086) < 1e-12, `totalCost ${cost.totalCost} should be ≈ 0.086`);
        });
    });

    suite("derivePriceCategory", () => {
        test("returns 'low' for models with very low per-token costs", () => {
            const pricing = {
                inputCostPerToken: 1e-7, // $0.10/1M
                outputCostPerToken: 5e-9, // $0.005/1M
            };
            assert.strictEqual(derivePriceCategory(pricing), "low");
        });

        test("returns 'low' for models with moderate low costs", () => {
            const pricing = {
                inputCostPerToken: 0.000001, // $1.00/1M
                outputCostPerToken: 0.000005, // $5.00/1M
            };
            assert.strictEqual(derivePriceCategory(pricing), "low");
        });

        test("returns 'medium' for models with mid-range costs", () => {
            const pricing = {
                inputCostPerToken: 0.000003, // $3.00/1M
                outputCostPerToken: 0.000015, // $15.00/1M
            };
            assert.strictEqual(derivePriceCategory(pricing), "medium");
        });

        test("returns 'high' for expensive models", () => {
            const pricing = {
                inputCostPerToken: 0.000015, // $15.00/1M
                outputCostPerToken: 0.000075, // $75.00/1M
            };
            assert.strictEqual(derivePriceCategory(pricing), "high");
        });

        test("returns 'very_high' for very expensive models", () => {
            const pricing = {
                inputCostPerToken: 0.00005, // $50.00/1M
                outputCostPerToken: 0.00015, // $150.00/1M
            };
            assert.strictEqual(derivePriceCategory(pricing), "very_high");
        });

        test("returns undefined when pricing is undefined", () => {
            assert.strictEqual(derivePriceCategory(undefined), undefined);
        });

        test("returns undefined when no cost fields are present", () => {
            const pricing = {
                inputCostPerToken: undefined,
                outputCostPerToken: undefined,
            };
            assert.strictEqual(derivePriceCategory(pricing), undefined);
        });

        test("derives category from input cost alone when output is missing", () => {
            const pricing = {
                inputCostPerToken: 0.00002, // $20.00/1M
                outputCostPerToken: undefined,
            };
            assert.strictEqual(derivePriceCategory(pricing), "high");
        });

        test("derives category from output cost alone when input is missing", () => {
            const pricing = {
                inputCostPerToken: undefined,
                outputCostPerToken: 0.00008, // $80.00/1M
            };
            assert.strictEqual(derivePriceCategory(pricing), "high");
        });
    });
});
