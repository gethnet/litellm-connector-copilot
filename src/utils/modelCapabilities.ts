import type * as vscode from "vscode";
import type { LiteLLMModelInfo, ModelCapabilityOverride, SupportedReasoningEffort } from "../types";
import { getDefaultEffort, getEffectiveEfforts } from "../config/modelOverrides";

export interface DerivedModelCapabilities {
    supportsTools: boolean;
    supportsVision: boolean;
    supportsStreaming: boolean;
    supportsReasoning: boolean;
    supportsPdf: boolean;
    // Additional capabilities derived from supports_* fields
    supportsAudioInput: boolean;
    supportsAudioOutput: boolean;
    supportsComputerUse: boolean;
    supportsFunctionCalling: boolean;
    supportsToolChoice: boolean;
    supportsSystemMessages: boolean;
    supportsResponseSchema: boolean;
    supportsPromptCaching: boolean;
    supportsWebSearch: boolean;
    supportsUrlContext: boolean;
    // Add reasoning_effort and thinking from supported_openai_params
    supportsReasoningEffort: boolean;
    supportsThinking: boolean;
    endpointMode: "chat" | "responses" | "completions";
    maxInputTokens: number;
    maxOutputTokens: number;
    rawContextWindow: number;
}

export function deriveCapabilitiesFromModelInfo(
    modelId: string,
    modelInfo?: LiteLLMModelInfo
): DerivedModelCapabilities {
    // Check supported_openai_params array for capability detection
    const supportedParams = modelInfo?.supported_openai_params ?? [];

    const hasExplicitReasoningEffort = Object.keys(LITELLM_REASONING_EFFORT_MAPPING).some(
        (key) => modelInfo?.[key as keyof LiteLLMModelInfo] === true
    );

    // Check ALL supports_* fields from model_info (treat null as undefined)
    const supportsTools = !!(supportedParams.includes("tools") || supportedParams.includes("functions"));
    const supportsFunctionCalling = modelInfo?.supports_function_calling === true;
    const supportsToolChoice = modelInfo?.supports_tool_choice === true;
    const supportsVision =
        modelInfo?.supports_vision === true ||
        (Array.isArray(modelInfo?.modalities) && (modelInfo.modalities as string[]).includes("vision"));
    const supportsAudioInput = modelInfo?.supports_audio_input === true;
    const supportsAudioOutput = modelInfo?.supports_audio_output === true;
    const supportsComputerUse = modelInfo?.supports_computer_use === true;
    const supportsSystemMessages = modelInfo?.supports_system_messages === true;
    const supportsResponseSchema = modelInfo?.supports_response_schema === true;
    const supportsPromptCaching = modelInfo?.supports_prompt_caching === true;
    const supportsWebSearch = modelInfo?.supports_web_search === true;
    const supportsUrlContext = modelInfo?.supports_url_context === true;
    const supportsNativeStreaming = modelInfo?.supports_native_streaming === true;
    const supportsPdf = modelInfo?.supports_pdf_input === true;

    // Reasoning capabilities
    const supportsReasoning =
        modelInfo?.supports_reasoning === true ||
        hasExplicitReasoningEffort ||
        modelInfo?.supported_openai_params?.includes("reasoning_effort") ||
        false;

    // Check if reasoning_effort and thinking appear in supported_openai_params
    const supportsReasoningEffort = supportedParams.includes("reasoning_effort");
    const supportsThinking = supportedParams.includes("thinking");

    const supportsStreaming = supportsNativeStreaming || supportedParams.includes("stream");

    const rawLimit = modelInfo?.max_input_tokens ?? modelInfo?.context_window_tokens ?? modelInfo?.max_tokens ?? 128000;
    const maxOutputTokens = modelInfo?.max_output_tokens ?? 16000;
    const maxInputTokens = Math.max(1, rawLimit - maxOutputTokens);

    return {
        supportsTools,
        supportsVision,
        supportsStreaming,
        supportsReasoning,
        supportsPdf,
        supportsAudioInput,
        supportsAudioOutput,
        supportsComputerUse,
        supportsFunctionCalling,
        supportsToolChoice,
        supportsSystemMessages,
        supportsResponseSchema,
        supportsPromptCaching,
        supportsWebSearch,
        supportsUrlContext,
        supportsReasoningEffort,
        supportsThinking,
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
    supports_medium_reasoning_effort: "medium",
    supports_high_reasoning_effort: "high",
    supports_xhigh_reasoning_effort: "xhigh",
    supports_max_reasoning_effort: "max",
} as const satisfies Record<string, SupportedReasoningEffort>;

/**
 * Default supported reasoning efforts when model explicitly supports reasoning
 * but doesn't specify exact effort levels (supports_reasoning: true).
 * Uses a conservative set to avoid unsupported effort flags being exposed in the UI.
 */
const DEFAULT_REASONING_EFFORTS: readonly SupportedReasoningEffort[] = ["none", "low", "medium", "high"];

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
function hasReasoningSignal(modelInfo?: LiteLLMModelInfo): boolean {
    if (!modelInfo) {
        return false;
    }
    // Direct support flag
    if (modelInfo.supports_reasoning === true) {
        return true;
    }
    // Check for explicit reasoning effort level fields
    return Object.keys(LITELLM_REASONING_EFFORT_MAPPING).some(
        (key) => modelInfo[key as keyof LiteLLMModelInfo] === true
    );
}

export function getSupportedReasoningEfforts(
    modelInfo?: LiteLLMModelInfo,
    modelId?: string,
    config?: vscode.WorkspaceConfiguration
): readonly SupportedReasoningEffort[] {
    // Without model info we cannot infer efforts (even if overrides exist)
    if (!modelInfo) {
        return [];
    }

    // Explicit false means no reasoning support unless overrides force it
    if (modelInfo?.supports_reasoning === false) {
        if (modelId) {
            const overrideEfforts = getEffectiveEfforts(modelId, modelInfo, config);
            if (overrideEfforts.length > 0) {
                return overrideEfforts;
            }
        }
        // Still check for explicit effort fields as some models may have them
        const explicitEfforts = extractExplicitReasoningEfforts(modelInfo);
        if (explicitEfforts.length > 0) {
            return explicitEfforts;
        }
        return [];
    }

    // First priority: explicit effort level fields from LiteLLM
    const explicitEfforts = extractExplicitReasoningEfforts(modelInfo);

    // Second priority: config overrides (may broaden or narrow explicit sets)
    let overrideEfforts: readonly SupportedReasoningEffort[] = [];
    if (modelId) {
        overrideEfforts = getEffectiveEfforts(modelId, modelInfo, config);
    }

    if (explicitEfforts.length > 0) {
        // If overrides provide a broader or different ladder, prefer them when non-empty
        if (overrideEfforts.length > 0) {
            return overrideEfforts;
        }
        return explicitEfforts;
    }

    if (overrideEfforts.length > 0) {
        return overrideEfforts;
    }

    // Third priority: Generic reasoning support flag
    if (hasReasoningSignal(modelInfo)) {
        return DEFAULT_REASONING_EFFORTS;
    }

    return [];
}

/**
 * Extract reasoning efforts from explicit effort level fields in LiteLLM model info.
 * Example: supports_high_reasoning_effort: true → includes "high"
 */
function extractExplicitReasoningEfforts(modelInfo?: LiteLLMModelInfo): SupportedReasoningEffort[] {
    if (!modelInfo) {
        return [];
    }

    const efforts = new Set<SupportedReasoningEffort>();
    for (const [key, effortValue] of Object.entries(LITELLM_REASONING_EFFORT_MAPPING)) {
        // Use safe property access - any null values treated as undefined
        const value = modelInfo[key as keyof LiteLLMModelInfo];
        if (value === true) {
            efforts.add(effortValue);
        }
    }

    // Sort efforts in standard order: none, minimal, low, medium, high, xhigh, max
    const effortOrder: SupportedReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    return effortOrder.filter((e) => efforts.has(e));
}

export function getDefaultReasoningEffort(
    supportedEfforts: readonly SupportedReasoningEffort[],
    modelId?: string,
    modelInfo?: LiteLLMModelInfo,
    config?: vscode.WorkspaceConfiguration
): SupportedReasoningEffort | undefined {
    if (supportedEfforts.length === 0) {
        return undefined;
    }

    if (modelId) {
        const overrideDefault = getDefaultEffort(modelId, modelInfo, config);
        if (overrideDefault) {
            return overrideDefault;
        }
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
        case "minimal":
            return "Lightweight reasoning";
        case "low":
            return "Faster responses with less reasoning";
        case "medium":
            return "Balanced reasoning and speed";
        case "high":
            return "Greater reasoning depth but slower";
        case "xhigh":
            return "Maximum reasoning depth but slower";
        case "max":
            return "Highest available reasoning effort";
        default:
            return effort;
    }
}

export function buildReasoningEffortConfigurationSchema(
    supportedEfforts: readonly SupportedReasoningEffort[],
    modelId?: string,
    modelInfo?: LiteLLMModelInfo,
    config?: vscode.WorkspaceConfiguration
):
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
                // NOTE: Intentionally no `default` field.
                //
                // VS Code re-calls provideLanguageModelChatInformation before every chat turn
                // (to validate the model is still available). If a `default` is present in the
                // schema, VS Code resets the picker to that value on every refresh — overwriting
                // whatever effort the user selected. Omitting `default` preserves the user's
                // choice across turns.
                //
                // If you need a starting value for first-time display, the picker already shows
                // the first enum entry when no value has been selected yet.
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
