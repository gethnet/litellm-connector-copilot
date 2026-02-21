import type { LanguageModelChatRequestMessage, LanguageModelTextPart } from "vscode";
import type { Tokenizer, TokenizationResult } from "./types";

export class HeuristicTokenizer implements Tokenizer {
    countTokens(text: string): TokenizationResult {
        // Basic chars/4 heuristic
        return { tokens: Math.ceil(text.length / 4) };
    }

    countMessageTokens(message: LanguageModelChatRequestMessage): TokenizationResult {
        let total = 0;
        if (typeof message.content === "string") {
            total += this.countTokens(message.content).tokens;
        } else {
            for (const part of message.content) {
                if (
                    typeof part === "object" &&
                    part !== null &&
                    "value" in part &&
                    typeof (part as unknown as LanguageModelTextPart).value === "string"
                ) {
                    total += this.countTokens((part as unknown as LanguageModelTextPart).value).tokens;
                }
                // Images are typically handled with a fixed cost or safety margin in the caller
            }
        }
        // Add overhead for roles/formatting (OpenAI-ish)
        return { tokens: total };
    }
}
