import type { LanguageModelChatRequestMessage, LanguageModelTextPart } from "vscode";
import type { Tokenizer, TokenizationResult } from "./types";

export class HeuristicTokenizer implements Tokenizer {
    countTokens(text: string): TokenizationResult {
        if (!text) {
            return { tokens: 0 };
        }
        // A more accurate heuristic than chars/4:
        // 1. Split by whitespace and punctuation
        // 2. Average tokens per word in code is higher than prose
        // 3. Common estimate: 1 word ≈ 1.3 tokens, or ~3.5 chars per token for code

        const words = text.trim().split(/\s+/).length;
        const charBased = Math.ceil(text.length / 3.5);
        const wordBased = Math.ceil(words * 1.3);

        // Take the max of char-based and word-based for a safer "upper bound" estimate
        return { tokens: Math.max(charBased, wordBased) };
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
