import * as vscode from "vscode";
import { Logger } from "../../utils/logger";
import { isCacheControlMimeType } from "../../utils";
import type { EmittedPart } from "./liteLLMStreamInterpreter";

export function emitV2PartsToVSCode(
    parts: EmittedPart[],
    progress: vscode.Progress<vscode.LanguageModelResponsePart | vscode.LanguageModelDataPart>
): void {
    for (const part of parts) {
        switch (part.type) {
            case "text": {
                const textValue = typeof part.value === "string" ? part.value : String(part.value ?? "");
                progress.report(new vscode.LanguageModelTextPart(textValue));
                break;
            }
            case "data": {
                // Defense-in-depth: the interpreter drops cache-control carrier
                // objects, but this boundary is the last chance to prevent VS Code
                // from recycling opaque prompt-cache metadata into future LLM input.
                if (isCacheControlMimeType(part.mimeType)) {
                    Logger.trace(`[vscodePartEmitter] Dropping cache_control data part (mimeType: ${part.mimeType})`);
                    break;
                }
                const mimeType = part.mimeType;

                // The `usage` mimetype must stay raw. `LanguageModelDataPart.json()` would
                // wrap it as JSON content and lose the special MIME type VS Code expects.
                if (mimeType === "usage") {
                    const payloadJson = typeof part.value === "string" ? part.value : JSON.stringify(part.value);
                    const payloadBytes = new TextEncoder().encode(payloadJson);
                    progress.report(new vscode.LanguageModelDataPart(payloadBytes, "usage"));
                    break;
                }

                // Guard: if mimeType starts with "text/" or includes "json", treat value as string|object; otherwise unknown
                const isTextLike = mimeType.startsWith("text/") || mimeType.includes("json");
                if (isTextLike) {
                    const safeValue: string | object =
                        typeof part.value === "string" ? part.value : JSON.stringify(part.value);
                    progress.report(vscode.LanguageModelDataPart.json(safeValue, mimeType));
                } else {
                    // Opaque binary data - report as-is (any type)
                    progress.report(vscode.LanguageModelDataPart.json(part.value as unknown, mimeType));
                }
                break;
            }
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
            case "tool_call": {
                if (part.id && part.name) {
                    try {
                        const argsRaw = part.args;
                        const args: Record<string, unknown> =
                            typeof argsRaw === "string" && argsRaw
                                ? (JSON.parse(argsRaw) as Record<string, unknown>)
                                : {};
                        progress.report(new vscode.LanguageModelToolCallPart(part.id, part.name, args));
                    } catch (parseErr) {
                        Logger.warn(`[vscodePartEmitter] Failed to parse tool call arguments`, {
                            toolName: part.name,
                            id: part.id,
                            argsPreview: typeof part.args === "string" ? part.args.slice(0, 160) : "<non-string>",
                            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
                        });
                        // Fallback: emit with raw string if the consumer can handle it, or empty object
                        progress.report(new vscode.LanguageModelToolCallPart(part.id, part.name, {}));
                    }
                }
                break;
            }
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
