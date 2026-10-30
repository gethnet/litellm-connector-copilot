import type { LanguageModelChatRequestMessage } from "vscode";

export interface TokenizationResult {
    tokens: number;
    /** Image/PDF estimates already included in tokens; excluded from text calibration. */
    mediaTokens?: number;
}

export interface Tokenizer {
    countTokens(text: string): TokenizationResult;
    countMessageTokens(message: LanguageModelChatRequestMessage): TokenizationResult;
}
