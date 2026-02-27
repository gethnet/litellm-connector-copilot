/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
import type { LanguageModelChatRequestMessage } from "vscode";
import type { Tokenizer, TokenizationResult } from "./types";

/**
 * Tiktoken-based tokenizer for precise token counting on OpenAI and compatible models.
 * Uses dynamic import for js-tiktoken to support ESM in CJS.
 */
export class TiktokenTokenizer implements Tokenizer {
    private _encoding: any | undefined;
    private readonly _modelId: string;

    constructor(modelId: string) {
        this._modelId = modelId;
    }

    private async _ensureEncoding(): Promise<any> {
        if (this._encoding) {
            return this._encoding;
        }

        const { getEncoding, getEncodingNameForModel } = await import("js-tiktoken");
        try {
            this._encoding = getEncoding(getEncodingNameForModel(this._modelId as any));
        } catch {
            this._encoding = getEncoding("cl100k_base");
        }
        return this._encoding;
    }

    countTokens(text: string): TokenizationResult {
        if (!text) {
            return { tokens: 0 };
        }
        // Fallback to heuristic if encoding not yet loaded (sync API requirement)
        if (!this._encoding) {
            // Pre-load encoding in background
            this._ensureEncoding().catch(() => {});
            return { tokens: Math.ceil(text.length / 3.5) };
        }
        return { tokens: this._encoding.encode(text).length };
    }

    countMessageTokens(message: LanguageModelChatRequestMessage): TokenizationResult {
        let total = 0;
        total += 3; // Overhead

        if (typeof message.content === "string") {
            total += this.countTokens(message.content).tokens;
        } else {
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    total += this.countTokens(part.value).tokens;
                }
            }
        }
        return { tokens: total };
    }
}
