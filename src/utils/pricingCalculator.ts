import type { LiteLLMModelInfo } from "../types";

/**
 * Structured pricing data extracted from LiteLLM's `/model/info` response.
 * All values are per-token costs in USD (matching LiteLLM's `*_cost_per_token` convention).
 * Undefined fields mean the pricing data was not provided by the backend.
 */
export interface ModelPricing {
    /** Cost per input (prompt) token in USD. */
    readonly inputCostPerToken?: number;
    /** Cost per output (completion) token in USD. */
    readonly outputCostPerToken?: number;
    /** Cost per cached input token (cache read) in USD. */
    readonly cacheReadCostPerToken?: number;
    /** Cost per cache creation input token in USD. */
    readonly cacheCreationCostPerToken?: number;
}

/**
 * Per-request cost breakdown computed from token usage × pricing.
 * All values are in USD. Zero when pricing data is unavailable.
 */
export interface RequestCost {
    /** Cost attributable to input (prompt) tokens, including cache adjustments. */
    readonly inputCost: number;
    /** Cost attributable to output (completion) tokens. */
    readonly outputCost: number;
    /** Combined total cost (input + output + cache adjustments). */
    readonly totalCost: number;
}

/**
 * Inputs required for cost calculation.
 */
export interface CostCalculationInput {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cachedTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly pricing: ModelPricing | undefined;
}

const PRICING_FIELDS = {
    inputCostPerToken: "input_cost_per_token",
    outputCostPerToken: "output_cost_per_token",
    cacheReadCostPerToken: "cache_read_input_token_cost",
    cacheCreationCostPerToken: "cache_creation_input_token_cost",
} as const;

function extractNumericField(modelInfo: LiteLLMModelInfo, field: string): number | undefined {
    const value = modelInfo[field as keyof LiteLLMModelInfo];
    if (value === null || value === undefined) {
        return undefined;
    }
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function extractPricing(modelInfo: LiteLLMModelInfo | undefined): ModelPricing | undefined {
    if (!modelInfo) {
        return undefined;
    }

    const nestedPricing = (modelInfo as { pricing?: Partial<ModelPricing> | undefined }).pricing;

    const pricing: ModelPricing = {
        inputCostPerToken:
            extractNumericField(modelInfo, PRICING_FIELDS.inputCostPerToken) ??
            (typeof nestedPricing?.inputCostPerToken === "number" ? nestedPricing.inputCostPerToken : undefined),
        outputCostPerToken:
            extractNumericField(modelInfo, PRICING_FIELDS.outputCostPerToken) ??
            (typeof nestedPricing?.outputCostPerToken === "number" ? nestedPricing.outputCostPerToken : undefined),
        cacheReadCostPerToken:
            extractNumericField(modelInfo, PRICING_FIELDS.cacheReadCostPerToken) ??
            (typeof nestedPricing?.cacheReadCostPerToken === "number"
                ? nestedPricing.cacheReadCostPerToken
                : undefined),
        cacheCreationCostPerToken:
            extractNumericField(modelInfo, PRICING_FIELDS.cacheCreationCostPerToken) ??
            (typeof nestedPricing?.cacheCreationCostPerToken === "number"
                ? nestedPricing.cacheCreationCostPerToken
                : undefined),
    };

    const hasValue =
        pricing.inputCostPerToken !== undefined ||
        pricing.outputCostPerToken !== undefined ||
        pricing.cacheReadCostPerToken !== undefined ||
        pricing.cacheCreationCostPerToken !== undefined;

    return hasValue ? pricing : undefined;
}

function formatPerMillion(costPerToken: number): string {
    // Avoid floating artifacts by rounding the base before formatting
    // normalize artifacts like 0.0249999999999 before formatting
    const perMillionRaw = costPerToken * 1_000_000;
    const perMillion = Number.parseFloat(perMillionRaw.toFixed(4));
    let decimals = 2;
    if (perMillion < 0.0001) {
        decimals = 6;
    } else if (perMillion < 1 && Math.abs(perMillion % 0.1) > 1e-9) {
        // Use 4 decimals for values below 1 that are not neat tenths (e.g., 0.125 → 0.1250)
        decimals = 4;
    }
    return `$${perMillion.toFixed(decimals)}/1M`;
}

export function formatPricingForDetail(pricing: ModelPricing | undefined): string {
    if (!pricing) {
        return "";
    }
    const parts: string[] = [];
    if (pricing.inputCostPerToken !== undefined) {
        parts.push(`${formatPerMillion(pricing.inputCostPerToken)} inp`);
    }
    if (pricing.outputCostPerToken !== undefined) {
        parts.push(`${formatPerMillion(pricing.outputCostPerToken)} out`);
    }
    return parts.join(" • ");
}

export function formatPricingForTooltip(pricing: ModelPricing | undefined): string {
    if (!pricing) {
        return "";
    }

    const lines: string[] = [];
    if (pricing.inputCostPerToken !== undefined) {
        lines.push(`Input: ${formatPerMillion(pricing.inputCostPerToken)} tokens`);
    }
    if (pricing.outputCostPerToken !== undefined) {
        lines.push(`Output: ${formatPerMillion(pricing.outputCostPerToken)} tokens`);
    }
    if (pricing.cacheReadCostPerToken !== undefined) {
        lines.push(`Cache read: ${formatPerMillion(pricing.cacheReadCostPerToken)} tokens`);
    }
    if (pricing.cacheCreationCostPerToken !== undefined) {
        lines.push(`Cache write: ${formatPerMillion(pricing.cacheCreationCostPerToken)} tokens`);
    }
    return lines.join("\n");
}

export function calculateRequestCost(input: CostCalculationInput): RequestCost {
    const { promptTokens, completionTokens, cachedTokens, cacheCreationInputTokens, pricing } = input;
    if (!pricing) {
        return { inputCost: 0, outputCost: 0, totalCost: 0 };
    }

    const nonCachedPromptTokens = Math.max(promptTokens - cachedTokens - cacheCreationInputTokens, 0);
    const cacheReadTokens = Math.max(cachedTokens, 0);
    const cacheCreationTokens = Math.max(cacheCreationInputTokens, 0);

    const inputCost =
        (pricing.inputCostPerToken ?? 0) * nonCachedPromptTokens +
        (pricing.cacheReadCostPerToken ?? 0) * cacheReadTokens +
        (pricing.cacheCreationCostPerToken ?? 0) * cacheCreationTokens;
    const outputCost = (pricing.outputCostPerToken ?? 0) * Math.max(completionTokens, 0);
    const totalCost = inputCost + outputCost;

    // Normalize floating point artifacts to a consistent precision.
    const round = (value: number): number => Number.parseFloat(value.toFixed(12));

    return { inputCost: round(inputCost), outputCost: round(outputCost), totalCost: round(totalCost) };
}

export function derivePriceCategory(pricing: ModelPricing | undefined): string | undefined {
    if (!pricing) {
        return undefined;
    }

    const perMillionCosts: number[] = [];
    if (pricing.inputCostPerToken !== undefined) {
        perMillionCosts.push(pricing.inputCostPerToken * 1_000_000);
    }
    if (pricing.outputCostPerToken !== undefined) {
        perMillionCosts.push(pricing.outputCostPerToken * 1_000_000);
    }

    if (perMillionCosts.length === 0) {
        return undefined;
    }

    const maxCost = Math.max(...perMillionCosts);

    if (maxCost <= 10) {
        return "low";
    }
    if (maxCost < 20) {
        return "medium";
    }
    if (maxCost <= 100) {
        return "high";
    }
    return "very_high";
}
