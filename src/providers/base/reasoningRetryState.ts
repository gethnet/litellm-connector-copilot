import type { LiteLLMAdaptiveThinking, OpenAIChatCompletionRequest, SupportedReasoningEffort } from "../../types";

const SUPPORTED_EFFORTS: readonly SupportedReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

const SUMMARY_VALUES = ["auto", "concise", "detailed"] as const;
type ReasoningSummary = (typeof SUMMARY_VALUES)[number];

export type ReasoningRetryState =
    | { kind: "absent" }
    | { kind: "none"; effort: "none" }
    | { kind: "adaptive"; effort: SupportedReasoningEffort; thinking: LiteLLMAdaptiveThinking }
    | { kind: "flat"; effort: SupportedReasoningEffort; summary?: ReasoningSummary };

function isSupportedEffort(value: unknown): value is SupportedReasoningEffort {
    return typeof value === "string" && (SUPPORTED_EFFORTS as readonly string[]).includes(value);
}

function isSummary(value: unknown): value is ReasoningSummary {
    return typeof value === "string" && (SUMMARY_VALUES as readonly string[]).includes(value);
}

function parseFlatEffort(
    value: OpenAIChatCompletionRequest["reasoning_effort"]
): { effort: SupportedReasoningEffort; summary?: ReasoningSummary } | undefined {
    if (isSupportedEffort(value)) {
        return { effort: value };
    }

    if (value && typeof value === "object" && isSupportedEffort(value.effort)) {
        return isSummary(value.summary) ? { effort: value.effort, summary: value.summary } : { effort: value.effort };
    }

    return undefined;
}

/**
 * Reads the complete reasoning representation. Missing `reasoning_effort` is
 * not "no effort" when native adaptive fields are present.
 */
export function readReasoningRetryState(request: OpenAIChatCompletionRequest): ReasoningRetryState {
    const flat = parseFlatEffort(request.reasoning_effort);
    // Explicit `none` is a disabled signal even if leftover native fields remain.
    if (flat?.effort === "none" || request.output_config?.effort === "none") {
        return { kind: "none", effort: "none" };
    }

    if (request.thinking?.type === "adaptive") {
        const adaptiveEffort = isSupportedEffort(request.output_config?.effort)
            ? request.output_config.effort
            : undefined;
        if (adaptiveEffort) {
            return {
                kind: "adaptive",
                effort: adaptiveEffort,
                thinking: { ...request.thinking },
            };
        }
    }

    if (!flat) {
        return { kind: "absent" };
    }
    return flat.summary
        ? { kind: "flat", effort: flat.effort, summary: flat.summary }
        : { kind: "flat", effort: flat.effort };
}

/**
 * Applies a (possibly lowered) effort without changing representation.
 * Absent requests are left untouched. Adaptive requests never gain
 * `reasoning_effort`; exhausted/disabled adaptive requests drop both native fields.
 */
export function applyReasoningRetryState(
    request: OpenAIChatCompletionRequest,
    state: ReasoningRetryState,
    effort: SupportedReasoningEffort | undefined
): void {
    if (state.kind === "absent") {
        return;
    }

    if (!effort || effort === "none") {
        if (effort === "none" || state.kind === "none") {
            request.reasoning_effort = "none";
        } else {
            delete request.reasoning_effort;
        }
        delete request.thinking;
        delete request.output_config;
        return;
    }

    if (state.kind === "adaptive") {
        delete request.reasoning_effort;
        request.thinking = { ...state.thinking };
        request.output_config = { effort };
        return;
    }

    request.reasoning_effort = state.kind === "flat" && state.summary ? { effort, summary: state.summary } : effort;
    delete request.thinking;
    delete request.output_config;
}

/**
 * Overwrites rebuilt request reasoning with the live retry state. Unlike
 * {@link applyReasoningRetryState}, an absent state clears restored picker fields.
 */
export function replaceReasoningRetryState(request: OpenAIChatCompletionRequest, state: ReasoningRetryState): void {
    if (state.kind === "absent") {
        delete request.reasoning_effort;
        delete request.thinking;
        delete request.output_config;
        return;
    }

    applyReasoningRetryState(request, state, state.effort);
}
