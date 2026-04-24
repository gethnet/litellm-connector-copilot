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
