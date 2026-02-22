import type * as vscode from "vscode";
import type { LiteLLMModelInfo } from "../types";

export interface DerivedModelCapabilities {
    supportsTools: boolean;
    supportsVision: boolean;
    supportsStreaming: boolean;
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

    const rawLimit = modelInfo?.max_input_tokens ?? modelInfo?.context_window_tokens ?? modelInfo?.max_tokens ?? 128000;
    const maxOutputTokens = modelInfo?.max_output_tokens ?? 16000;
    const maxInputTokens = Math.max(1, rawLimit - maxOutputTokens);

    return {
        supportsTools,
        supportsVision,
        supportsStreaming,
        endpointMode: (modelInfo?.mode as "chat" | "responses" | "completions") ?? "chat",
        maxInputTokens,
        maxOutputTokens,
        rawContextWindow: rawLimit,
    };
}

export function capabilitiesToVSCode(derived: DerivedModelCapabilities): vscode.LanguageModelChatCapabilities {
    return {
        // VS Code currently supports these two main ones
        toolCalling: derived.supportsTools,
        imageInput: derived.supportsVision,
    };
}

export function getModelTags(
    modelId: string,
    derived: DerivedModelCapabilities,
    overrides?: Record<string, string[]>
): string[] {
    const tags = new Set<string>();

    const modelName = modelId.toLowerCase();
    if (modelName.includes("coder") || modelName.includes("code")) {
        tags.add("inline-edit");
    }

    if (derived.supportsTools) {
        tags.add("tools");
    }

    if (derived.supportsVision) {
        tags.add("vision");
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
