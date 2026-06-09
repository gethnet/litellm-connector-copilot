import type { LanguageModelChatRequestMessage } from "vscode";
import type { Tokenizer, TokenizationResult } from "./types";
import { StructuredLogger } from "../../observability/structuredLogger";

export class HeuristicTokenizer implements Tokenizer {
    static STRUCTURED_LOGGER_ENABLED = true;

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
            StructuredLogger.trace("Part rejected - non-object type", {
                type: typeof part,
                keysPresent: [],
            });
            return 0;
        }

        // Extract keys for inspection (only those that could relate to our types)
        const keysPresent = new Set<string>([]);

        if ("value" in part) {
            const value = (part as { value?: string | string[] }).value;
            keysPresent.add("value");
            if (typeof value === "string") {
                const tokens = this.countTokens(value).tokens;
                StructuredLogger.debug("Counting string value tokens", {
                    length: value.length,
                    characterBased: Math.ceil(value.length / 3.5),
                    wordBased: Math.ceil(value.trim().split(/\s+/).length * 1.3),
                    resultTokens: tokens,
                });
                return tokens;
            }
            if (Array.isArray(value)) {
                const joined = value.join("");
                const tokens = this.countTokens(joined).tokens;
                StructuredLogger.debug("Counting array of strings tokens", {
                    arrayLength: value.length,
                    joinedLength: joined.length,
                    characterBased: Math.ceil(joined.length / 3.5),
                    wordBased: Math.ceil(joined.trim().split(/\s+/).length * 1.3),
                    resultTokens: tokens,
                });
                return tokens;
            }
        }

        if ("name" in part && "input" in part) {
            keysPresent.add("name").add("input");
            const toolCall = part as { name?: string; input?: unknown };
            const serialized = `${toolCall.name ?? ""}${JSON.stringify(toolCall.input ?? {})}`;
            const tokens = this.countTokens(serialized).tokens;
            StructuredLogger.debug("Counting tool call tokens", {
                name: toolCall.name ?? "(empty)",
                inputKeys: Object.keys(toolCall.input ?? {}),
                serializedLength: serialized.length,
                resultTokens: tokens,
            });
            return tokens;
        }

        if ("mimeType" in part && "data" in part) {
            keysPresent.add("mimeType").add("data");
            const dataPart = part as { mimeType?: string; data?: Uint8Array };
            if (
                typeof dataPart.mimeType === "string" &&
                dataPart.data instanceof Uint8Array &&
                (dataPart.mimeType.startsWith("text/") ||
                    dataPart.mimeType.includes("json") ||
                    dataPart.mimeType === "usage")
            ) {
                const textContent = Buffer.from(dataPart.data).toString("utf-8");
                const tokens = this.countTokens(textContent).tokens;
                StructuredLogger.debug("Counting text/json data part tokens", {
                    mimeType: dataPart.mimeType,
                    dataLength: dataPart.data.length,
                    textLength: textContent.length,
                    resultTokens: tokens,
                });
                return tokens;
            }
        }

        if ("content" in part && Array.isArray((part as { content?: unknown[] }).content)) {
            keysPresent.add("content");
            const arrayContent = (part as { content: unknown[] }).content;
            const totalTokens = arrayContent.reduce<number>((sum, item) => sum + this.countPartTokens(item), 0);
            StructuredLogger.debug("Counting nested content array tokens", {
                innerArrayLength: arrayContent.length,
                totalTokens,
            });
            return totalTokens;
        }

        StructuredLogger.trace("Unknown part shape - no match among expected types", {
            keysPresent: Array.from(keysPresent),
        });
        return 0;
    }
}
