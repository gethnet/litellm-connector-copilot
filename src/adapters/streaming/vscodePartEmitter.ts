import * as vscode from "vscode";
import { Logger } from "../../utils/logger";
import { isCacheControlMimeType } from "../../utils";
import { StructuredLogger } from "../../observability/structuredLogger";
import type { EmittedPart } from "./liteLLMStreamInterpreter";

export function emitV2PartsToVSCode(
    parts: EmittedPart[],
    progress: vscode.Progress<vscode.LanguageModelResponsePart | vscode.LanguageModelDataPart>
): void {
    Logger.trace(`[vscodePartEmitter] Emitting ${parts.length} parts to VS Code`);
    StructuredLogger.trace("vscode.emit_parts_start", {
        partCount: parts.length,
        partTypes: parts.reduce(
            (acc, p) => {
                const type = p.type;
                acc[type] = (acc[type] ?? 0) + 1;
                return acc;
            },
            {} as Record<string, number>
        ),
    });

    for (let idx = 0; idx < parts.length; idx++) {
        const part = parts[idx];
        switch (part.type) {
            case "text": {
                const textValue = typeof part.value === "string" ? part.value : String(part.value ?? "");
                Logger.trace(`[vscodePartEmitter] Part #${idx}: text, ${textValue.length} chars`);
                progress.report(new vscode.LanguageModelTextPart(textValue));
                StructuredLogger.trace("vscode.text_part_emitted", {
                    partIndex: idx,
                    length: textValue.length,
                    preview: textValue.substring(0, 100),
                });
                break;
            }
            case "data": {
                // Defense-in-depth: the interpreter drops cache-control carrier
                // objects, but this boundary is the last chance to prevent VS Code
                // from recycling opaque prompt-cache metadata into future LLM input.
                if (isCacheControlMimeType(part.mimeType)) {
                    Logger.trace(`[vscodePartEmitter] Part #${idx}: data (cache_control) - DROPPED`);
                    StructuredLogger.trace("vscode.data_part_dropped", {
                        partIndex: idx,
                        reason: "cache_control_mimeType",
                        mimeType: part.mimeType,
                    });
                    break;
                }
                const mimeType = part.mimeType;

                // The `usage` mimetype must stay raw. `LanguageModelDataPart.json()` would
                // wrap it as JSON content and lose the special MIME type VS Code expects.
                if (mimeType === "usage") {
                    const payloadJson = typeof part.value === "string" ? part.value : JSON.stringify(part.value);
                    const payloadBytes = new TextEncoder().encode(payloadJson);
                    Logger.trace(`[vscodePartEmitter] Part #${idx}: data (usage), ${payloadBytes.length} bytes`);
                    progress.report(new vscode.LanguageModelDataPart(payloadBytes, "usage"));
                    StructuredLogger.trace("vscode.usage_part_emitted", {
                        partIndex: idx,
                        byteLength: payloadBytes.length,
                        payload: typeof part.value === "string" ? part.value : JSON.stringify(part.value),
                    });
                    break;
                }

                // Guard: if mimeType starts with "text/" or includes "json", treat value as string|object; otherwise unknown
                const isTextLike = mimeType.startsWith("text/") || mimeType.includes("json");
                Logger.trace(`[vscodePartEmitter] Part #${idx}: data (${mimeType}), isTextLike=${isTextLike}`);
                if (isTextLike) {
                    const safeValue: string | object =
                        typeof part.value === "string" ? part.value : JSON.stringify(part.value);
                    progress.report(vscode.LanguageModelDataPart.json(safeValue, mimeType));
                    StructuredLogger.trace("vscode.data_part_emitted", {
                        partIndex: idx,
                        mimeType,
                        format: "json",
                        sizeEstimate: JSON.stringify(safeValue).length,
                    });
                } else {
                    // Opaque binary data - report as-is (any type)
                    progress.report(vscode.LanguageModelDataPart.json(part.value as unknown, mimeType));
                    StructuredLogger.trace("vscode.data_part_emitted", {
                        partIndex: idx,
                        mimeType,
                        format: "opaque",
                    });
                }
                break;
            }
            case "thinking": {
                const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
                    | (new (value: string | string[], id?: string, metadata?: Record<string, unknown>) => unknown)
                    | undefined;
                if (ThinkingPart) {
                    const thinkingValue = typeof part.value === "string" ? part.value : String(part.value ?? "");
                    Logger.trace(`[vscodePartEmitter] Part #${idx}: thinking, ${thinkingValue.length} chars`);
                    progress.report(
                        new ThinkingPart(part.value, part.id, part.metadata) as vscode.LanguageModelResponsePart
                    );
                    StructuredLogger.trace("vscode.thinking_part_emitted", {
                        partIndex: idx,
                        length: thinkingValue.length,
                        id: part.id,
                        preview: thinkingValue.substring(0, 100),
                    });
                } else {
                    Logger.warn(
                        `[vscodePartEmitter] Part #${idx}: thinking part skipped (LanguageModelThinkingPart not available)`
                    );
                }
                break;
            }
            case "tool_call": {
                if (part.id && part.name) {
                    Logger.trace(`[vscodePartEmitter] Part #${idx}: tool_call, name=${part.name} id=${part.id}`);
                    try {
                        const argsRaw = part.args;
                        const args: Record<string, unknown> =
                            typeof argsRaw === "string" && argsRaw
                                ? (JSON.parse(argsRaw) as Record<string, unknown>)
                                : {};
                        Logger.trace(
                            `[vscodePartEmitter] Tool call args parsed successfully, keys: ${Object.keys(args).join(", ")}`
                        );
                        progress.report(new vscode.LanguageModelToolCallPart(part.id, part.name, args));
                        StructuredLogger.trace("vscode.tool_call_part_emitted", {
                            partIndex: idx,
                            toolName: part.name,
                            id: part.id,
                            argsLength: argsRaw?.length ?? 0,
                            argKeys: Object.keys(args),
                        });
                    } catch (parseErr) {
                        Logger.warn(`[vscodePartEmitter] Part #${idx}: Failed to parse tool call arguments`, {
                            toolName: part.name,
                            id: part.id,
                            argsPreview: typeof part.args === "string" ? part.args.slice(0, 160) : "<non-string>",
                            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
                        });
                        // Fallback: emit with raw string if the consumer can handle it, or empty object
                        progress.report(new vscode.LanguageModelToolCallPart(part.id, part.name, {}));
                        StructuredLogger.warn("vscode.tool_call_parse_failed", {
                            partIndex: idx,
                            toolName: part.name,
                            id: part.id,
                            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
                        });
                    }
                } else {
                    Logger.trace(`[vscodePartEmitter] Part #${idx}: tool_call skipped (missing id or name)`);
                }
                break;
            }
            case "response": {
                Logger.debug(`[vscodePartEmitter] Part #${idx}: response metadata (not emitted as part)`);
                StructuredLogger.trace("vscode.response_part_received", {
                    partIndex: idx,
                    usage: part.usage,
                });
                break;
            }
            case "finish": {
                Logger.debug(`[vscodePartEmitter] Part #${idx}: finish (reason=${part.reason}) - not emitted as part`);
                StructuredLogger.trace("vscode.finish_part_received", {
                    partIndex: idx,
                    reason: part.reason,
                });
                break;
            }
        }
    }

    Logger.trace(`[vscodePartEmitter] Finished emitting ${parts.length} parts to VS Code`);
    StructuredLogger.trace("vscode.emit_parts_complete", {
        partCount: parts.length,
    });
}

export const emitPartsToVSCode = emitV2PartsToVSCode;
