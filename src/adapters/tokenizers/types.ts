import type { LanguageModelChatRequestMessage } from "vscode";

export interface TokenizationResult {
    tokens: number;
}

export interface Tokenizer {
    countTokens(text: string): TokenizationResult;
    countMessageTokens(message: LanguageModelChatRequestMessage): TokenizationResult;
}

export type TokenizationStrategy = "heuristic" | "tiktoken";
