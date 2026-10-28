import * as vscode from "vscode";
import { hasResponsesReasoningMetadata, thinkingPartId } from "../../adapters/reasoningContinuity";

/**
 * Native Responses state that will not be replayed (chat routes, unsupported or unscoped
 * native routes) is removed before trimming so a summary that will never be sent cannot
 * displace text/tools or cause a false overflow. A message left empty by the removal is
 * dropped instead of failing request validation.
 */
export function omitResponsesReasoningFromHistory(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
): readonly vscode.LanguageModelChatRequestMessage[] {
    return messages.flatMap((message) => {
        const isCarrier = (part: unknown): boolean =>
            !(part instanceof vscode.LanguageModelTextPart) && hasResponsesReasoningMetadata(part);
        const carriers = message.content.filter(isCarrier);
        if (carriers.length === 0) {
            return [message];
        }
        const ids = new Set(carriers.map(thinkingPartId).filter((id): id is string => id !== undefined));
        const content = message.content.filter(
            (part) =>
                part instanceof vscode.LanguageModelTextPart ||
                (!isCarrier(part) && !ids.has(thinkingPartId(part) ?? ""))
        );
        return content.length > 0 ? [{ ...message, content }] : [];
    });
}
