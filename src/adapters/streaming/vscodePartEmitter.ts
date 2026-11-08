import * as vscode from "vscode";
import { Logger } from "../../utils/logger";
import { safeUsageNumber } from "../../utils/safeUsageNumber";
import { isCacheControlMimeType } from "../../utils";
import { StructuredLogger } from "../../observability/structuredLogger";
import type { EmittedPart } from "./liteLLMStreamInterpreter";
import type { StreamLogContext } from "./responsesReasoningEvents";
import { safeFinishReason } from "./streamTerminalFingerprint";
import { diagnosticHash } from "./diagnosticHash";

type ThinkingPartConstructor = new (
    value: string | string[],
    id?: string,
    metadata?: Record<string, unknown>
) => vscode.LanguageModelResponsePart;

function getThinkingPartConstructor(): ThinkingPartConstructor | undefined {
    return (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
        ThinkingPartConstructor | undefined;
}

/** Emits parts unchanged and attaches optional request context to every vscode emitter event. */
export function emitV2PartsToVSCode(
    parts: EmittedPart[],
    progress: vscode.Progress<vscode.LanguageModelResponsePart | vscode.LanguageModelDataPart>,
    thinkingPartConstructor: ThinkingPartConstructor | null | undefined = getThinkingPartConstructor(),
    logContext?: StreamLogContext
): void {
    Logger.trace(`[vscodePartEmitter] Emitting ${parts.length} parts to VS Code`);
    StructuredLogger.trace(
        "vscode.emit_parts_start",
        {
            partCount: parts.length,
            partTypes: parts.reduce(
                (acc, p) => {
                    const type = p.type;
                    acc[type] = (acc[type] ?? 0) + 1;
                    return acc;
                },
                {} as Record<string, number>
            ),
        },
        logContext
    );

    for (let idx = 0; idx < parts.length; idx++) {
        const part = parts[idx];
        switch (part.type) {
            case "text": {
                const textValue = typeof part.value === "string" ? part.value : String(part.value ?? "");
                Logger.trace(`[vscodePartEmitter] Part #${idx}: text, ${textValue.length} chars`);
                progress.report(new vscode.LanguageModelTextPart(textValue));
                StructuredLogger.trace(
                    "vscode.text_part_emitted",
                    {
                        partIndex: idx,
                        length: textValue.length,
                    },
                    logContext
                );
                break;
            }
            case "data": {
                // Defense-in-depth: the interpreter drops cache-control carrier
                // objects, but this boundary is the last chance to prevent VS Code
                // from recycling opaque prompt-cache metadata into future LLM input.
                if (isCacheControlMimeType(part.mimeType)) {
                    Logger.trace(`[vscodePartEmitter] Part #${idx}: data (cache_control) - DROPPED`);
                    StructuredLogger.trace(
                        "vscode.data_part_dropped",
                        {
                            partIndex: idx,
                            reason: "cache_control_mimeType",
                            mimeType: diagnosticHash(part.mimeType),
                        },
                        logContext
                    );
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
                    StructuredLogger.trace(
                        "vscode.usage_part_emitted",
                        {
                            partIndex: idx,
                            byteLength: payloadBytes.length,
                        },
                        logContext
                    );
                    break;
                }

                // Guard: if mimeType starts with "text/" or includes "json", treat value as string|object; otherwise unknown
                const isTextLike = mimeType.startsWith("text/") || mimeType.includes("json");
                Logger.trace(
                    `[vscodePartEmitter] Part #${idx}: data (mime hash=${diagnosticHash(mimeType)}), isTextLike=${isTextLike}`
                );
                if (isTextLike) {
                    const safeValue: string | object =
                        typeof part.value === "string" ? part.value : JSON.stringify(part.value);
                    progress.report(vscode.LanguageModelDataPart.json(safeValue, mimeType));
                    StructuredLogger.trace(
                        "vscode.data_part_emitted",
                        {
                            partIndex: idx,
                            mimeType: diagnosticHash(mimeType),
                            format: "json",
                            sizeEstimate: JSON.stringify(safeValue).length,
                        },
                        logContext
                    );
                } else {
                    // Opaque binary data - report as-is (any type)
                    progress.report(vscode.LanguageModelDataPart.json(part.value as unknown, mimeType));
                    StructuredLogger.trace(
                        "vscode.data_part_emitted",
                        {
                            partIndex: idx,
                            mimeType: diagnosticHash(mimeType),
                            format: "opaque",
                        },
                        logContext
                    );
                }
                break;
            }
            case "thinking": {
                const ThinkingPart = thinkingPartConstructor;
                if (ThinkingPart) {
                    const thinkingValue = typeof part.value === "string" ? part.value : String(part.value ?? "");
                    Logger.trace(`[vscodePartEmitter] Part #${idx}: thinking, ${thinkingValue.length} chars`);
                    progress.report(
                        new ThinkingPart(part.value, part.id, part.metadata) as vscode.LanguageModelResponsePart
                    );
                    StructuredLogger.trace(
                        "vscode.thinking_part_emitted",
                        {
                            partIndex: idx,
                            length: thinkingValue.length,
                            id: diagnosticHash(part.id),
                        },
                        logContext
                    );
                } else {
                    const fallbackValue = typeof part.value === "string" ? part.value : String(part.value ?? "");
                    if (fallbackValue.length > 0) {
                        Logger.warn(
                            `[vscodePartEmitter] Part #${idx}: ThinkingPart unavailable — emitting *text* fallback (${fallbackValue.length} chars)`
                        );
                        progress.report(new vscode.LanguageModelTextPart(`*${fallbackValue}*`));
                        StructuredLogger.debug(
                            "vscode.thinking_part_fallback_emitted",
                            {
                                partIndex: idx,
                                length: fallbackValue.length,
                            },
                            logContext
                        );
                    } else {
                        Logger.warn(
                            `[vscodePartEmitter] Part #${idx}: metadata-only thinking part skipped (ThinkingPart unavailable)`
                        );
                    }
                }
                break;
            }
            case "tool_call": {
                if (part.id && part.name) {
                    Logger.trace(
                        `[vscodePartEmitter] Part #${idx}: tool_call, name hash=${diagnosticHash(part.name)} id hash=${diagnosticHash(part.id)}`
                    );
                    try {
                        const argsRaw = part.args;
                        const args: Record<string, unknown> =
                            typeof argsRaw === "string" && argsRaw
                                ? (JSON.parse(argsRaw) as Record<string, unknown>)
                                : {};
                        const argKeyCount = Object.keys(args).length;
                        Logger.trace(
                            `[vscodePartEmitter] Tool call args parsed successfully, key count: ${argKeyCount}`
                        );
                        progress.report(new vscode.LanguageModelToolCallPart(part.id, part.name, args));
                        StructuredLogger.trace(
                            "vscode.tool_call_part_emitted",
                            {
                                partIndex: idx,
                                toolName: diagnosticHash(part.name),
                                id: diagnosticHash(part.id),
                                argsLength: argsRaw?.length ?? 0,
                                argKeyCount,
                            },
                            logContext
                        );
                    } catch (parseErr) {
                        Logger.warn(`[vscodePartEmitter] Part #${idx}: Failed to parse tool call arguments`, {
                            toolName: diagnosticHash(part.name),
                            id: diagnosticHash(part.id),
                            argsLength: typeof part.args === "string" ? part.args.length : 0,
                        });
                        // Fallback: emit with raw string if the consumer can handle it, or empty object
                        progress.report(new vscode.LanguageModelToolCallPart(part.id, part.name, {}));
                        StructuredLogger.warn(
                            "vscode.tool_call_parse_failed",
                            {
                                partIndex: idx,
                                toolName: diagnosticHash(part.name),
                                id: diagnosticHash(part.id),
                                errorType: parseErr instanceof SyntaxError ? "syntax_error" : "unknown",
                            },
                            logContext
                        );
                    }
                } else {
                    Logger.trace(`[vscodePartEmitter] Part #${idx}: tool_call skipped (missing id or name)`);
                }
                break;
            }
            case "response": {
                Logger.debug(`[vscodePartEmitter] Part #${idx}: response metadata (not emitted as part)`);
                StructuredLogger.trace(
                    "vscode.response_part_received",
                    {
                        partIndex: idx,
                        usage: {
                            inputTokens: safeUsageNumber(part.usage?.inputTokens),
                            outputTokens: safeUsageNumber(part.usage?.outputTokens),
                        },
                    },
                    logContext
                );
                break;
            }
            case "finish": {
                const reason = safeFinishReason(part.reason);
                Logger.debug(`[vscodePartEmitter] Part #${idx}: finish (reason=${reason}) - not emitted as part`);
                StructuredLogger.trace(
                    "vscode.finish_part_received",
                    {
                        partIndex: idx,
                        reason,
                    },
                    logContext
                );
                break;
            }
        }
    }

    Logger.trace(`[vscodePartEmitter] Finished emitting ${parts.length} parts to VS Code`);
    StructuredLogger.trace(
        "vscode.emit_parts_complete",
        {
            partCount: parts.length,
        },
        logContext
    );
}

export const emitPartsToVSCode = emitV2PartsToVSCode;
