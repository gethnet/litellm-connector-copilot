import * as assert from "assert";
import * as vscode from "vscode";
import { HeuristicTokenizer } from "../heuristicTokenizer";

suite("HeuristicTokenizer Unit Tests", () => {
    suite("countPartTokens", () => {
        const tokenizer = new HeuristicTokenizer();

        test("returns 0 for non-object inputs", () => {
            assert.strictEqual(tokenizer["countPartTokens"](null), 0);
            assert.strictEqual(tokenizer["countPartTokens"]("not an object"), 0);
            assert.strictEqual(tokenizer["countPartTokens"](42), 0);
            assert.strictEqual(tokenizer["countPartTokens"](undefined), 0);
            assert.strictEqual(tokenizer["countPartTokens"](true), 0);
            assert.strictEqual(tokenizer["countPartTokens"]([]), 0);
        });

        test("counts string values from value property", () => {
            const part = { value: "hello world" };
            const result = tokenizer["countPartTokens"](part);
            assert.ok(result > 0);
            // "hello world" has 2 words -> 2 * 1.3 = 2.6 -> 3 tokens
            // chars: 11 / 3.5 = 3.14 -> 4 tokens
            const expected = Math.max(Math.ceil(11 / 3.5), Math.ceil(2.6));
            assert.strictEqual(result, expected);
        });

        test("counts array of strings from value property", () => {
            const part = { value: ["Hello", "world"] };
            const result = tokenizer["countPartTokens"](part);
            assert.ok(result > 0);
            // Array joined by empty string: "Helloworld" -> 9 chars, is treated as 1 word (no space)
            // Char-based: ceil(9/3.5) = 3, Word-based: ceil(1*1.3) = 2
            assert.strictEqual(result, 3);
        });

        test("skips unknown shapes when value is present but invalid", () => {
            const part = { value: 123 } as { value?: unknown };
            const result = tokenizer["countPartTokens"](part);
            assert.strictEqual(result, 0);
        });

        test("counts tool calls with name and input", () => {
            const part = { name: "search", input: { query: "test", count: 5 } };
            const result = tokenizer["countPartTokens"](part);
            assert.ok(result > 0);
            const textToCount = `search${JSON.stringify({ query: "test", count: 5 })}`;
            const expected = tokenizer.countTokens(textToCount).tokens;
            assert.strictEqual(result, expected);
        });

        test("counts empty tool call (name only)", () => {
            const part = { name: "" };
            const result = tokenizer["countPartTokens"](part);
            assert.strictEqual(result, 0);
        });

        test("counts tool call with empty input object", () => {
            const part = { name: "test", input: {} };
            const result = tokenizer["countPartTokens"](part);
            const textToCount = `test${JSON.stringify({})}`;
            const expected = tokenizer.countTokens(textToCount).tokens;
            assert.strictEqual(result, expected);
        });

        test("estimates tokens for image data parts with mime type image/png", () => {
            const imageData = new Uint8Array(1000); // 1KB image data
            const part = { mimeType: "image/png", data: imageData };
            const result = tokenizer["countPartTokens"](part);
            // Should estimate image tokens: 85 base + ceil(1000/750) ≈ 87
            assert.ok(result >= 85, `Expected at least 85 tokens for image, got ${result}`);
        });

        test("handles json mime type in data part", () => {
            const jsonText = '{"key": "value"}';
            const part = { mimeType: "application/json", data: Buffer.from(jsonText) };
            const result = tokenizer["countPartTokens"](part);
            assert.strictEqual(result, tokenizer.countTokens(jsonText).tokens);
        });

        test("estimates tokens for jpeg image data parts", () => {
            const part = { mimeType: "image/jpeg", data: new Uint8Array(500) };
            const result = tokenizer["countPartTokens"](part);
            // Should estimate image tokens
            assert.ok(result >= 85, `Expected at least 85 tokens for JPEG, got ${result}`);
        });

        test("estimates tokens for pdf data parts", () => {
            const part = { mimeType: "application/pdf", data: new Uint8Array(2000) };
            const result = tokenizer["countPartTokens"](part);
            // PDF: ceil(2000/4) = 500 tokens
            assert.ok(result >= 100, `Expected at least 100 tokens for PDF, got ${result}`);
        });

        test("estimates tokens for webp image data parts", () => {
            const part = { mimeType: "image/webp", data: new Uint8Array(800) };
            const result = tokenizer["countPartTokens"](part);
            assert.ok(result >= 85, `Expected at least 85 tokens for WebP, got ${result}`);
        });

        test("estimates tokens for gif image data parts", () => {
            const part = { mimeType: "image/gif", data: new Uint8Array(600) };
            const result = tokenizer["countPartTokens"](part);
            assert.ok(result >= 85, `Expected at least 85 tokens for GIF, got ${result}`);
        });

        test("skips data parts without valid text mime types", () => {
            const part = { mimeType: "application/octet-stream", data: Buffer.from([0x00]) };
            const result = tokenizer["countPartTokens"](part);
            assert.strictEqual(result, 0);
        });

        test("handles data part with usage mime type", () => {
            const usageText = '{"prompt_tokens": 100, "completion_tokens": 50}';
            const part = { mimeType: "usage", data: Buffer.from(usageText) };
            const result = tokenizer["countPartTokens"](part);
            assert.strictEqual(result, tokenizer.countTokens(usageText).tokens);
        });

        test("recursively counts content array parts", () => {
            const part1 = { value: "Hello" };
            const part2 = { value: " World" };
            const content = [part1, part2];
            const part = { content };
            const result = tokenizer["countPartTokens"](part);
            const combined = "Hello World";
            const expected = tokenizer.countTokens(combined).tokens;
            assert.strictEqual(result, expected);
        });

        test("handles deep nested content arrays", () => {
            const innerPart = { value: "test" };
            const content = { content: [innerPart] };
            const result = tokenizer["countPartTokens"](content);
            const expected = tokenizer.countTokens("test").tokens;
            assert.strictEqual(result, expected);
        });

        test("returns 0 for unknown object shapes", () => {
            const part = { unknown: "field" };
            const result = tokenizer["countPartTokens"](part);
            assert.strictEqual(result, 0);
        });

        test("handles zero-length string in value", () => {
            const part = { value: "" };
            const result = tokenizer["countPartTokens"](part);
            assert.strictEqual(result, tokenizer.countTokens("").tokens);
            assert.strictEqual(result, 0);
        });

        test("prioritizes exact key presence over subtype checks", () => {
            const partWithContent = { content: [{ value: "nested" }] };
            const result = tokenizer["countPartTokens"](partWithContent);
            assert.ok(result > 0);
        });
    });

    suite("countTokens and countMessageTokens", () => {
        const tokenizer = new HeuristicTokenizer();

        test("countTokens uses safer upper bound estimate", () => {
            const text = "Test with multiple words and punctuation!";
            const words = text.trim().split(/\s+/).length;
            const result = tokenizer.countTokens(text).tokens;
            const charBased = Math.ceil(text.length / 3.5);
            const wordBased = Math.ceil(words * 1.3);
            const expected = Math.max(charBased, wordBased);
            assert.strictEqual(result, expected);
        });

        test("countTokens returns 0 for empty string", () => {
            assert.strictEqual(tokenizer.countTokens("").tokens, 0);
            assert.strictEqual(tokenizer["countPartTokens"]({ value: "" }), 0);
        });

        test("handles string content in messages", () => {
            const msg = {
                role: vscode.LanguageModelChatMessageRole.User,
                content: "Hello world",
                name: undefined,
            } as unknown as vscode.LanguageModelChatRequestMessage;
            const result = tokenizer.countMessageTokens(msg);
            assert.ok(result.tokens > 0);
        });

        test("handles array content with text parts", () => {
            const msg = {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("Hello world")],
                name: undefined,
            } as unknown as vscode.LanguageModelChatRequestMessage;
            const result = tokenizer.countMessageTokens(msg);
            assert.ok(result.tokens > 0);
        });

        test("handles array content with mixed part types", () => {
            const part1 = { value: "Hello" };
            const part2 = { name: "search", input: { q: "test" } };
            const msg = {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [part1, part2],
                name: undefined,
            } as unknown as vscode.LanguageModelChatRequestMessage;
            const result = tokenizer.countMessageTokens(msg);
            assert.ok(result.tokens > 0);
        });

        test("handles array content with content arrays (nested)", () => {
            const inner1 = { value: "test1" };
            const inner2 = { value: "test2" };
            const nested = { content: [inner1, inner2] };
            const msg = {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [nested],
                name: undefined,
            } as unknown as vscode.LanguageModelChatRequestMessage;
            const result = tokenizer.countMessageTokens(msg);
            assert.ok(result.tokens > 2);
        });
    });
});
