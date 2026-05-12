import type * as vscode from "vscode";
import type { LiteLLMModelInfo, ModelCapabilityOverride } from "../types";

export interface DerivedModelCapabilities {
    supportsTools: boolean;
    supportsVision: boolean;
    supportsStreaming: boolean;
    supportsReasoning: boolean;
    supportsPdf: boolean;
    endpointMode: "chat" | "responses" | "completions";
    maxInputTokens: number;
    maxOutputTokens: number;
    rawContextWindow: number;
}

export type SupportedReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function deriveCapabilitiesFromModelInfo(
    modelId: string,
    modelInfo?: LiteLLMModelInfo
): DerivedModelCapabilities {
    const supportsTools = !!(
        modelInfo?.supported_openai_params?.includes("tools") ||
        modelInfo?.supported_openai_params?.includes("tool_choice")
    );
    const supportsVision = !!(
        modelInfo?.supports_vision ||
        (Array.isArray(modelInfo?.modalities) && (modelInfo.modalities as string[]).includes("vision"))
    );
    const supportsStreaming = !!(
        modelInfo?.supports_native_streaming || modelInfo?.supported_openai_params?.includes("stream")
    );
    const supportsReasoning = !!modelInfo?.supports_reasoning;
    const supportsPdf = !!modelInfo?.supports_pdf_input;

    const rawLimit = modelInfo?.max_input_tokens ?? modelInfo?.context_window_tokens ?? modelInfo?.max_tokens ?? 128000;
    const maxOutputTokens = modelInfo?.max_output_tokens ?? 16000;
    const maxInputTokens = Math.max(1, rawLimit - maxOutputTokens);

    return {
        supportsTools,
        supportsVision,
        supportsStreaming,
        supportsReasoning,
        supportsPdf,
        endpointMode: (modelInfo?.mode as "chat" | "responses" | "completions") ?? "chat",
        maxInputTokens,
        maxOutputTokens,
        rawContextWindow: rawLimit,
    };
}

export function capabilitiesToVSCode(
    derived: DerivedModelCapabilities,
    overrides?: ModelCapabilityOverride
): vscode.LanguageModelChatCapabilities {
    return {
        // VS Code currently supports these two main ones
        toolCalling: overrides?.toolCalling ?? derived.supportsTools,
        imageInput: overrides?.imageInput ?? derived.supportsVision,
    };
}

export function getModelTags(
    modelId: string,
    derived: DerivedModelCapabilities,
    overrides?: Record<string, string[]>,
    capabilityOverrides?: ModelCapabilityOverride
): string[] {
    const tags = new Set<string>();

    const modelName = modelId.toLowerCase();
    if (modelName.includes("coder") || modelName.includes("code")) {
        tags.add("inline-edit");
    }

    // Use capability override if set, otherwise use derived value
    const effectiveTools = capabilityOverrides?.toolCalling ?? derived.supportsTools;
    const effectiveVision = capabilityOverrides?.imageInput ?? derived.supportsVision;
    const effectiveReasoning = capabilityOverrides?.reasoning ?? derived.supportsReasoning;
    const effectivePdf = capabilityOverrides?.pdfInput ?? derived.supportsPdf;

    if (effectiveTools) {
        tags.add("tools");
    }

    if (effectiveVision) {
        tags.add("vision");
    }

    if (effectiveReasoning) {
        tags.add("reasoning");
    }

    if (effectivePdf) {
        tags.add("pdf");
    }

    if (derived.supportsStreaming) {
        tags.add("inline-completions");
        tags.add("terminal-chat");
    }

    if (overrides && overrides[modelId]) {
        for (const tag of overrides[modelId]) {
            tags.add(tag);
        }
    }

    return Array.from(tags);
}

/**
 * Mapping of LiteLLM reasoning effort fields to standard effort values.
 * This supports the 5 LiteLLM reasoning effort levels for model picker UI.
 */
const LITELLM_REASONING_EFFORT_MAPPING: Record<string, SupportedReasoningEffort> = {
    supports_minimal_reasoning_effort: "minimal",
    supports_low_reasoning_effort: "low",
    supports_xlow_reasoning_effort: "low",
    supports_high_reasoning_effort: "high",
    supports_xhigh_reasoning_effort: "xhigh",
} as const satisfies Record<string, SupportedReasoningEffort>;

/**
 * Default supported reasoning efforts when model explicitly supports reasoning
 * but doesn't specify exact effort levels (supports_reasoning: true).
 */
const DEFAULT_REASONING_EFFORTS: readonly SupportedReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
];

/**
 * Type definition for extended properties on LanguageModelChatInformation.
 */
export type ExtendedModelInformation = vscode.LanguageModelChatInformation & {
    vendor?: string;
    backendName?: string;
    tags?: string[];
    detail?: string;
    tooltip?: string;
};

/**
 * Determine supported reasoning efforts for a model based on its LiteLLM model info.
 *
 * Returns an array of supported effort values (strings) that can be exposed in the
 * VS Code model picker UI. Mappings support both standard and alias variants.
 *
 * Priority order for determining effort levels:
 * 1. Explicit level fields (supports_minimal_reasoning_effort, supports_low_reasoning_effort, etc.)
 * 2. General reasoning support (supports_reasoning: true) → ["low", "medium", "high"]
 * 3. No reasoning support → empty array
 *
 * @param modelInfo LiteLLM model information with reasoning capabilities
 * @returns Array of supported reasoning effort strings
 */
export function getSupportedReasoningEfforts(modelInfo?: LiteLLMModelInfo): readonly SupportedReasoningEffort[] {
    if (!modelInfo) {
        return [];
    }

    const explicitlySupportedEfforts = new Set<SupportedReasoningEffort>();
    for (const [litellmField, mappedEffort] of Object.entries(LITELLM_REASONING_EFFORT_MAPPING)) {
        if (modelInfo[litellmField as keyof LiteLLMModelInfo] === true) {
            explicitlySupportedEfforts.add(mappedEffort);
        }
    }

    if (explicitlySupportedEfforts.size > 0) {
        return [
            "none",
            ...DEFAULT_REASONING_EFFORTS.filter(
                (effort) => effort !== "none" && explicitlySupportedEfforts.has(effort)
            ),
        ];
    }

    if (modelInfo.supports_reasoning === true) {
        return DEFAULT_REASONING_EFFORTS;
    }

    return [];
}

export function getDefaultReasoningEffort(
    supportedEfforts: readonly SupportedReasoningEffort[]
): SupportedReasoningEffort | undefined {
    if (supportedEfforts.length === 0) {
        return undefined;
    }

    if (supportedEfforts.includes("medium")) {
        return "medium";
    }

    return supportedEfforts.find((effort) => effort !== "none") ?? supportedEfforts[0];
}

/**
 * Per-effort descriptions shown alongside each option in VS Code's model picker hover popup.
 * VS Code renders these via `enumDescriptions` — one entry per enum value, in the same order.
 * Without this array the picker shows only the label (e.g. "Medium") with no explanatory text,
 * meaning users have no guidance on what each effort level actually does.
 */
function getEffortDescription(effort: SupportedReasoningEffort): string {
    switch (effort) {
        case "none":
            return "No reasoning applied";
        case "low":
            return "Faster responses with less reasoning";
        case "medium":
            return "Balanced reasoning and speed";
        case "high":
            return "Greater reasoning depth but slower";
        case "xhigh":
            return "Maximum reasoning depth but slower";
        default:
            return effort;
    }
}

export function buildReasoningEffortConfigurationSchema(supportedEfforts: readonly SupportedReasoningEffort[]):
    | {
          properties: {
              reasoningEffort: {
                  type: "string";
                  // VS Code uses `title` as the section heading in the hover popup (e.g. "Thinking Effort").
                  title: string;
                  enum: SupportedReasoningEffort[];
                  // Human-readable labels aligned with `enum` — shown in the picker list instead of raw values.
                  enumItemLabels: string[];
                  // Per-item descriptions rendered next to each option in the hover popup.
                  // This is what causes VS Code to display the "Faster responses…" / "Balanced…" lines.
                  enumDescriptions: string[];
                  default?: SupportedReasoningEffort;
                  // Must be "navigation" for VS Code 1.120 to surface this as an inline picker action
                  // rather than hiding it in the secondary configuration UI.
                  group: "navigation";
              };
          };
      }
    | undefined {
    if (supportedEfforts.length === 0) {
        return undefined;
    }

    const defaultEffort = getDefaultReasoningEffort(supportedEfforts);
    return {
        properties: {
            reasoningEffort: {
                type: "string",
                // "Thinking Effort" matches the label VS Code's own Copilot models use, so the
                // section heading in the hover popup is consistent with the native experience.
                title: "Thinking Effort",
                enum: [...supportedEfforts],
                enumItemLabels: supportedEfforts.map((effort) => effort.charAt(0).toUpperCase() + effort.slice(1)),
                // Per-item descriptions — renders the explanatory text beside each effort option
                // in the VS Code model-picker hover popup (e.g. "Balanced reasoning and speed").
                enumDescriptions: supportedEfforts.map(getEffortDescription),
                default: defaultEffort,
                group: "navigation",
            },
        },
    };
}

/**
 * Convert LiteLLM effort field names from arbitrary database keys to standard effort strings.
 *
 * Some LiteLLM models may have effort level fields named differently (e.g., camelCase, prefixed).
 * This helper normalizes them to the standard effort strings used in the picker.
 *
 * @param modelInfo LiteLLM model information with reasoning capabilities
 * @returns Standardized reasoning effort string or undefined if not supported
 */
export function resolveReasoningEffort(modelInfo?: LiteLLMModelInfo): SupportedReasoningEffort | undefined {
    const supports = getSupportedReasoningEfforts(modelInfo);
    return getDefaultReasoningEffort(supports);
}

/**
 * Centralized helper to format how a model is displayed in UI surfaces.
 * Uses raw string values.
 *
 * @param modelOrName The extended model information object, or the raw model name string.
 * @param vendor Optional raw provider/vendor name (used only if modelOrName is a string).
 * @returns A consistent UI label
 */
export function formatModelDisplayLabel(modelOrName: ExtendedModelInformation | string, vendor?: string): string {
    if (typeof modelOrName === "string") {
        return vendor ? `[${vendor}] ${modelOrName}` : modelOrName;
    }

    const modelVendor = modelOrName.vendor;
    return modelVendor ? `[${modelVendor}] ${modelOrName.name}` : modelOrName.name;
}
