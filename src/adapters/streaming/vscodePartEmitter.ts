import * as vscode from "vscode";
import type { EmittedPart } from "./liteLLMStreamInterpreter";

export function emitV2PartsToVSCode(
    parts: EmittedPart[],
    progress: vscode.Progress<vscode.LanguageModelResponsePart | vscode.LanguageModelDataPart>
): void {
    for (const part of parts) {
        switch (part.type) {
            case "text":
                progress.report(new vscode.LanguageModelTextPart(part.value));
                break;
            case "data":
                progress.report(vscode.LanguageModelDataPart.json(part.value, part.mimeType));
                break;
            case "thinking": {
                const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
                    | (new (value: string | string[], id?: string, metadata?: Record<string, unknown>) => unknown)
                    | undefined;
                if (ThinkingPart) {
                    progress.report(
                        new ThinkingPart(part.value, part.id, part.metadata) as vscode.LanguageModelResponsePart
                    );
                }
                break;
            }
            case "tool_call":
                if (part.id && part.name) {
                    try {
                        const args = part.args ? JSON.parse(part.args) : {};
                        progress.report(new vscode.LanguageModelToolCallPart(part.id, part.name, args));
                    } catch (e) {
                        // Log the error but don't crash the entire response stream
                        console.error(`Failed to parse tool call arguments for ${part.name}:`, e);
                        // Fallback: emit with raw string if the consumer can handle it, or empty object
                        progress.report(new vscode.LanguageModelToolCallPart(part.id, part.name, {}));
                    }
                }
                break;
            case "response":
                break;
            case "finish":
                // VS Code doesn't have a specific finish part in the progress stream,
                // it's inferred by the end of the stream.
                break;
        }
    }
}

export const emitPartsToVSCode = emitV2PartsToVSCode;
