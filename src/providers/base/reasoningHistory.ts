import * as vscode from "vscode";
import { hasResponsesReasoningMetadata } from "../../adapters/reasoningContinuity";

function thinkingId(part: unknown): string | undefined {
    return typeof part === "object" && part !== null && "value" in part && "id" in part && typeof part.id === "string"
        ? part.id
        : undefined;
}

/**
 * Native Responses state has no chat-completions wire representation. Remove it before
 * trimming so a summary that will never be sent cannot displace text/tools or cause a
 * false overflow. The final HTTP projection remains a separate defense-in-depth guard.
 */
export function omitResponsesReasoningFromHistory(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
): readonly vscode.LanguageModelChatRequestMessage[] {
    return messages.map((message) => {
        const isCarrier = (part: unknown): boolean =>
            !(part instanceof vscode.LanguageModelTextPart) && hasResponsesReasoningMetadata(part);
        const carriers = message.content.filter(isCarrier);
        if (carriers.length === 0) {
            return message;
        }
        const ids = new Set(carriers.map(thinkingId).filter((id): id is string => id !== undefined));
        return {
            ...message,
            content: message.content.filter(
                (part) =>
                    part instanceof vscode.LanguageModelTextPart ||
                    (!isCarrier(part) && !ids.has(thinkingId(part) ?? ""))
            ),
        };
    });
}
