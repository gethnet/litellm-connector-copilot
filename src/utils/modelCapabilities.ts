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
 * Converts a lowercase provider ID to a properly-cased display name.
 * Handles special cases like multi-word providers (e.g., "openrouter" → "Open Router")
 * and single-letter edge cases (e.g., "xai" → "xAI").
 *
 * Algorithm:
 * 1. Handle known special casing (xai → xAI)
 * 2. Split on uppercase letters to detect word boundaries (e.g., "openrouter" is one word, but common compound words are handled)
 * 3. Title-case each word and join with space
 */
export function formatProviderName(provider: string): string {
    const lower = provider.toLowerCase().trim();

    // Known special cases that don't follow standard rules
    switch (lower) {
        case "xai":
            return "xAI";
        case "openai":
            return "OpenAI";
        case "vertexai":
            return "VertexAI";
        case "vertex_ai":
            return "VertexAI";
        default:
            break;
    }

    // Detect and preserve acronyms: common two-letter endings that should be uppercase
    // (e.g., "openai" → "Open AI", "bedrock" → "Bedrock", "xai" → "xAI")
    const acronymSuffixes = ["ai", "ml", "xr"];

    let result = lower;
    for (const suffix of acronymSuffixes) {
        if (lower.endsWith(suffix) && lower.length > suffix.length) {
            // Replace the suffix with itself in uppercase, preserving the rest
            result = lower.slice(0, -suffix.length) + suffix.toUpperCase();
            break;
        }
    }

    // Split on hyphens, underscores, and camelCase boundaries
    const parts = result
        .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase (e.g., openAI → open AI)
        .replace(/[-_]/g, " ") // hyphens and underscores
        .split(/\s+/)
        .filter((p) => p.length > 0);

    // Title-case each part and join with space
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

/**
 * Converts a raw model ID to a human-readable display name.
 * Splits by hyphens, title-cases each part, fully capitalizes short lowercase words (e.g., "gpt" → "GPT"),
 * and joins with spaces for readability.
 */
export function formatModelName(modelName: string): string {
    return modelName
        .split("-")
        .map((part) => {
            if (/^\d/.test(part)) {
                return part;
            } // Keep numbers as-is (e.g., "4o", "3")
            if (part.length <= 3 && /^[a-z]+$/.test(part) && part !== "pro" && part !== "max" && part !== "my") {
                return part.toUpperCase();
            } // Fully capitalize short words except specific non-acronyms
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(); // Title-case longer words
        })
        .join(" ");
}
