import type { LanguageModelChatRequestMessage } from "vscode";
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
                total += this.countPartTokens(part);
                // Images are typically handled with a fixed cost or safety margin in the caller
            }
        }
        // Add overhead for roles/formatting (OpenAI-ish)
        return { tokens: total };
    }

    private countPartTokens(part: unknown): number {
        if (typeof part !== "object" || part === null) {
            return 0;
        }

        if ("value" in part) {
            const value = (part as { value?: string | string[] }).value;
            if (typeof value === "string") {
                return this.countTokens(value).tokens;
            }
            if (Array.isArray(value)) {
                return this.countTokens(value.join("")).tokens;
            }
        }

        if ("name" in part && "input" in part) {
            const toolCall = part as { name?: string; input?: unknown };
            return this.countTokens(`${toolCall.name ?? ""}${JSON.stringify(toolCall.input ?? {})}`).tokens;
        }

        if ("mimeType" in part && "data" in part) {
            const dataPart = part as { mimeType?: string; data?: Uint8Array };
            if (
                typeof dataPart.mimeType === "string" &&
                dataPart.data instanceof Uint8Array &&
                (dataPart.mimeType.startsWith("text/") ||
                    dataPart.mimeType.includes("json") ||
                    dataPart.mimeType === "usage")
            ) {
                return this.countTokens(Buffer.from(dataPart.data).toString("utf-8")).tokens;
            }
        }

        if ("content" in part && Array.isArray((part as { content?: unknown[] }).content)) {
            return (part as { content: unknown[] }).content.reduce<number>(
                (sum, item) => sum + this.countPartTokens(item),
                0
            );
        }

        return 0;
    }
}
