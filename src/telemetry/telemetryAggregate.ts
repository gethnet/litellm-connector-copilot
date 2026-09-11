/**
 * Per-tuple bounded aggregator for telemetry summaries.
 *
 * The bounds protect PostHog dashboards and storage from runaway cardinality
 * even when the upstream caller sends an unbounded stream of identities. The
 * overflow bucket keeps accurate request counts so dashboards that pivot on
 * `request_count` are not silently truncated, with a distinct `overflow: true`
 * flag that cannot collide with any real `(modelId, caller)` tuple.
 *
 * The helper is intentionally pure: it does not touch VS Code, PostHog,
 * timers, logging, or request ids. The `TelemetryService` owns the timer,
 * consent, and event-routing concerns; this module only owns the math.
 */
export interface AggregateSample {
    modelId: string;
    caller: string;
    durationMs?: number;
    tokensIn?: number;
    tokensOut?: number;
    cacheReadRatio?: number;
    estimatedInputCost?: number;
    estimatedOutputCost?: number;
    estimatedTotalCost?: number;
}

export interface AggregateSummary {
    model_id: string;
    caller: string;
    request_count: number;
    duration_count: number;
    duration_sum_ms: number;
    duration_max_ms: number;
    tokens_in: number;
    tokens_out: number;
    cache_ratio_numerator: number;
    cache_ratio_denominator: number;
    input_cost_count: number;
    input_cost_sum: number;
    output_cost_count: number;
    output_cost_sum: number;
    total_cost_count: number;
    total_cost_sum: number;
    overflow: boolean;
}

interface MutableAggregate {
    modelId: string;
    caller: string;
    requestCount: number;
    durationCount: number;
    durationSumMs: number;
    durationMaxMs: number;
    tokensIn: number;
    tokensOut: number;
    cacheRatioNumerator: number;
    cacheRatioDenominator: number;
    inputCostCount: number;
    inputCostSum: number;
    outputCostCount: number;
    outputCostSum: number;
    totalCostCount: number;
    totalCostSum: number;
    overflow: boolean;
}

type CostKind = "inputCost" | "outputCost" | "totalCost";

const OVERFLOW_MODEL = "__overflow__";
const OVERFLOW_CALLER = "__overflow__";

export class BoundedTelemetryAggregate {
    private readonly entries = new Map<string, MutableAggregate>();
    private readonly overflowEntry: MutableAggregate = this.createEntry(OVERFLOW_MODEL, OVERFLOW_CALLER, true);

    public constructor(private readonly maxEntries = 128) {}

    public add(sample: AggregateSample): void {
        const key = JSON.stringify([sample.modelId, sample.caller]);
        const entry = this.entries.get(key) ?? this.getOrCreateEntry(key, sample);
        this.addToEntry(entry, sample);
    }

    public isEmpty(): boolean {
        return this.entries.size === 0 && this.overflowEntry.requestCount === 0;
    }

    public drain(): AggregateSummary[] {
        const summaries: AggregateSummary[] = [];
        for (const entry of this.entries.values()) {
            summaries.push(this.toSummary(entry));
        }
        if (this.overflowEntry.requestCount > 0) {
            summaries.push(this.toSummary(this.overflowEntry));
        }
        this.entries.clear();
        this.resetEntry(this.overflowEntry);
        return summaries;
    }

    private getOrCreateEntry(key: string, sample: AggregateSample): MutableAggregate {
        if (this.entries.size < this.maxEntries) {
            const entry = this.createEntry(sample.modelId, sample.caller, false);
            this.entries.set(key, entry);
            return entry;
        }
        return this.overflowEntry;
    }

    private createEntry(modelId: string, caller: string, overflow: boolean): MutableAggregate {
        return {
            modelId,
            caller,
            requestCount: 0,
            durationCount: 0,
            durationSumMs: 0,
            durationMaxMs: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheRatioNumerator: 0,
            cacheRatioDenominator: 0,
            inputCostCount: 0,
            inputCostSum: 0,
            outputCostCount: 0,
            outputCostSum: 0,
            totalCostCount: 0,
            totalCostSum: 0,
            overflow,
        };
    }

    private resetEntry(entry: MutableAggregate): void {
        const replacement = this.createEntry(entry.modelId, entry.caller, entry.overflow);
        Object.assign(entry, replacement);
    }

    private addToEntry(entry: MutableAggregate, sample: AggregateSample): void {
        entry.requestCount += 1;

        if (sample.durationMs !== undefined && Number.isFinite(sample.durationMs) && sample.durationMs >= 0) {
            entry.durationCount += 1;
            entry.durationSumMs += sample.durationMs;
            entry.durationMaxMs = Math.max(entry.durationMaxMs, sample.durationMs);
        }
        if (sample.tokensIn !== undefined && Number.isFinite(sample.tokensIn) && sample.tokensIn >= 0) {
            entry.tokensIn += sample.tokensIn;
        }
        if (sample.tokensOut !== undefined && Number.isFinite(sample.tokensOut) && sample.tokensOut >= 0) {
            entry.tokensOut += sample.tokensOut;
        }
        // Cache ratio is weighted by input tokens so dashboards can compute a true
        // average ratio from numerator/denominator without distortion from small
        // requests dominating the unweighted average.
        if (
            sample.cacheReadRatio !== undefined &&
            Number.isFinite(sample.cacheReadRatio) &&
            sample.cacheReadRatio >= 0 &&
            sample.cacheReadRatio <= 1 &&
            sample.tokensIn !== undefined &&
            Number.isFinite(sample.tokensIn) &&
            sample.tokensIn > 0
        ) {
            entry.cacheRatioNumerator += sample.cacheReadRatio * sample.tokensIn;
            entry.cacheRatioDenominator += sample.tokensIn;
        }

        this.addKnownCost(entry, "inputCost", sample.estimatedInputCost);
        this.addKnownCost(entry, "outputCost", sample.estimatedOutputCost);
        this.addKnownCost(entry, "totalCost", sample.estimatedTotalCost);
    }

    private addKnownCost(entry: MutableAggregate, kind: CostKind, value: number | undefined): void {
        if (value === undefined || !Number.isFinite(value) || value < 0) {
            return;
        }
        switch (kind) {
            case "inputCost":
                entry.inputCostCount += 1;
                entry.inputCostSum += value;
                return;
            case "outputCost":
                entry.outputCostCount += 1;
                entry.outputCostSum += value;
                return;
            case "totalCost":
                entry.totalCostCount += 1;
                entry.totalCostSum += value;
                return;
        }
    }

    private toSummary(entry: MutableAggregate): AggregateSummary {
        return {
            model_id: entry.modelId,
            caller: entry.caller,
            request_count: entry.requestCount,
            duration_count: entry.durationCount,
            duration_sum_ms: entry.durationSumMs,
            duration_max_ms: entry.durationMaxMs,
            tokens_in: entry.tokensIn,
            tokens_out: entry.tokensOut,
            cache_ratio_numerator: entry.cacheRatioNumerator,
            cache_ratio_denominator: entry.cacheRatioDenominator,
            input_cost_count: entry.inputCostCount,
            input_cost_sum: entry.inputCostSum,
            output_cost_count: entry.outputCostCount,
            output_cost_sum: entry.outputCostSum,
            total_cost_count: entry.totalCostCount,
            total_cost_sum: entry.totalCostSum,
            overflow: entry.overflow,
        };
    }
}
