import type { LanguageModelChatRequestMessage } from "vscode";

export interface TokenizationResult {
    tokens: number;
    /** Included in tokens, but not subject to text calibration. */
    mediaTokens?: number;
}

export interface Tokenizer {
    countTokens(text: string): TokenizationResult;
    countMessageTokens(message: LanguageModelChatRequestMessage): TokenizationResult;
}
