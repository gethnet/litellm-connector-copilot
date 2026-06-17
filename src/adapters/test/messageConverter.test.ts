import * as assert from "assert";
import { convertMessagesToOpenAI } from "../messageConverter";
import type { V2ChatMessage } from "../../providers/v2Types";
import type { MessageConversionOptions } from "../messageConverter";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

// ── helpers ──────────────────────────────────────────────────────────────────

const defaultOptions: MessageConversionOptions = {
    normalizeToolCallId: (id: string) => id,
};

/**
 * Build a V2ChatMessage containing a single tool_result part.
 * The `content` array is passed through directly to exercise
 * `serializeToolResultItem` branches.
 */
function toolResultMessage(callId: string, content: unknown[]): V2ChatMessage {
    return {
        role: "user",
        name: undefined,
        content: [{ type: "tool_result", callId, content }],
    };
}

/**
 * Convert a single tool_result message and return the resulting
 * OpenAI "tool" message content string.
 */
function toolResultContent(content: unknown[], callId = "call-1"): string {
    const messages = convertMessagesToOpenAI([toolResultMessage(callId, content)], defaultOptions);
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "Expected a tool-role message in output");
    assert.ok(typeof toolMsg.content === "string", "Expected tool message content to be a string");
    return toolMsg.content;
}

/**
 * Mock constructor that stands in for `LanguageModelTextPart` when
 * injected into `globalThis.vscode`.
 */
class MockTextPart {
    readonly value: string;
    constructor(value: string) {
        this.value = value;
    }
}

/**
 * Mock constructor that stands in for `LanguageModelDataPart` when
 * injected into `globalThis.vscode`.
 */
class MockDataPart {
    readonly mimeType: string;
    readonly data: Uint8Array;
    constructor(mimeType: string, data: Uint8Array) {
        this.mimeType = mimeType;
        this.data = data;
    }
}

interface VSCodeGlobalShim {
    LanguageModelTextPart?: typeof MockTextPart;
    LanguageModelDataPart?: typeof MockDataPart;
}

/**
 * Install mock VS Code constructors on `globalThis.vscode` and return
 * a teardown callback that restores the previous value.
 */
function installVSCodeGlobal(shim: VSCodeGlobalShim): () => void {
    const g = globalThis as Record<string, unknown>;
    const saved = g.vscode;
    g.vscode = shim;
    return () => {
        if (saved === undefined) {
            delete g.vscode;
        } else {
            g.vscode = saved;
        }
    };
}

// ── existing suite (unchanged) ───────────────────────────────────────────────

suite("Message Converters Tool Name Sanitization", () => {
    test("applies tool name sanitization in convertMessagesToOpenAI for Bedrock compliance", () => {
        const message: V2ChatMessage = {
            role: "assistant",
            name: undefined,
            content: [
                {
                    type: "tool_call",
                    callId: "test-call-1",
                    name: "create-file_with-dash_and_underscore",
                    input: { path: "example.txt" },
                },
            ],
        };

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => id,
        };

        const result = convertMessagesToOpenAI([message], options);

        const toolCall = result.find((r) => r.tool_calls && r.tool_calls.length > 0);
        assert.ok(toolCall, "Expected an assistant message with tool calls");
        assert.ok(toolCall.tool_calls);
        assert.ok(toolCall.tool_calls[0]);
        assert.ok(toolCall.tool_calls[0].function);
        assert.ok(toolCall.tool_calls[0].function.name);

        const name = toolCall.tool_calls[0].function.name;
        assert.ok(/^[a-zA-Z]/.test(name), `Name should start with letter, got: ${name}`);
        assert.ok(name.length <= 66, `Name should be <=66 chars (tool_ + 64), got length ${name}: ${name}`);
    });

    test("handles tool name exceeding 64 characters (edge case)", () => {
        const longName = "a".repeat(100);
        const message: V2ChatMessage = {
            role: "assistant",
            name: undefined,
            content: [
                {
                    type: "tool_call",
                    callId: "test-call-2",
                    name: longName,
                    input: {},
                },
            ],
        };

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => id,
        };

        const result = convertMessagesToOpenAI([message], options);

        const toolCall = result.find((r) => r.tool_calls && r.tool_calls.length > 0);
        assert.ok(toolCall, "Expected an assistant message with tool calls");
        assert.ok(toolCall.tool_calls);
        assert.ok(toolCall.tool_calls[0]);
        assert.ok(toolCall.tool_calls[0].function);
        assert.ok(toolCall.tool_calls[0].function.name);

        const name = toolCall.tool_calls[0].function.name;
        assert.ok(name.length <= 66, `Name should be <=66 chars (tool_ + 64), got length ${name}: ${name}`);
    });

    test("handles tool name starting with number - prefix with tool_", () => {
        const message: V2ChatMessage = {
            role: "assistant",
            name: undefined,
            content: [
                {
                    type: "tool_call",
                    callId: "test-call-3",
                    name: "123start",
                    input: {},
                },
            ],
        };

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => id,
        };

        const result = convertMessagesToOpenAI([message], options);

        const toolCall = result.find((r) => r.tool_calls && r.tool_calls.length > 0);
        assert.ok(toolCall, "Expected an assistant message with tool calls");
        assert.ok(toolCall.tool_calls);
        assert.ok(toolCall.tool_calls[0]);
        assert.ok(toolCall.tool_calls[0].function);
        assert.ok(toolCall.tool_calls[0].function.name);

        assert.ok(
            /^tool_/.test(toolCall.tool_calls[0].function.name),
            `Name should start with tool_, got: ${toolCall.tool_calls[0].function.name}`
        );
    });
});

// ── new suite: serializeToolResultItem via convertMessagesToOpenAI ────────────

suite("Message Converters — serializeToolResultItem (via convertMessagesToOpenAI)", () => {
    // ── Branch: VS Code native TextPart ────────────────────────────────────

    test("returns text content for LanguageModelTextPart instances when VS Code global is available", () => {
        const teardown = installVSCodeGlobal({ LanguageModelTextPart: MockTextPart });
        try {
            const items = [new MockTextPart("hello from text part")];
            const result = toolResultContent(items as unknown[]);
            assert.strictEqual(result, "hello from text part");
        } finally {
            teardown();
        }
    });

    test("returns unwrapped text when single TextPart is the only tool result item", () => {
        const teardown = installVSCodeGlobal({ LanguageModelTextPart: MockTextPart });
        try {
            const items = [new MockTextPart("only child")];
            const result = toolResultContent(items as unknown[]);
            // Single text item should be unwrapped (not JSON-wrapped)
            assert.strictEqual(result, "only child");
        } finally {
            teardown();
        }
    });

    // ── Branch: plain string items ─────────────────────────────────────────

    test("returns text content for plain string items", () => {
        const result = toolResultContent(["plain string value"]);
        assert.strictEqual(result, "plain string value");
    });

    test("returns unwrapped text for single string item", () => {
        const result = toolResultContent(["single"]);
        assert.strictEqual(result, "single");
    });

    test("handles empty string item", () => {
        // Empty string is falsy for text join but still a valid item;
        // serializeToolResultContent falls through to JSON envelope when
        // the joined text is empty and there are content items.
        const result = toolResultContent([""]);
        // Single text item with empty text → unwrapped ""
        assert.strictEqual(result, "");
    });

    // ── Branch: VS Code native DataPart with cache-control MIME ────────────

    test("drops DataPart items with 'cache_control' MIME type", () => {
        const teardown = installVSCodeGlobal({ LanguageModelDataPart: MockDataPart });
        try {
            const cacheItem = new MockDataPart("cache_control", new Uint8Array([1, 2, 3]));
            const result = toolResultContent([cacheItem as unknown]);
            // Only item was dropped → serializeToolResultContent returns "Success"
            assert.strictEqual(result, "Success");
        } finally {
            teardown();
        }
    });

    test("drops DataPart items with 'application/vnd.anthropic.cache-control' MIME type", () => {
        const teardown = installVSCodeGlobal({ LanguageModelDataPart: MockDataPart });
        try {
            const cacheItem = new MockDataPart("application/vnd.anthropic.cache-control+json", new Uint8Array([1]));
            const result = toolResultContent([cacheItem as unknown]);
            assert.strictEqual(result, "Success");
        } finally {
            teardown();
        }
    });

    test("drops DataPart items with MIME type containing 'cache-control' substring", () => {
        const teardown = installVSCodeGlobal({ LanguageModelDataPart: MockDataPart });
        try {
            const cacheItem = new MockDataPart("text/x-cache-control", new Uint8Array([0]));
            const result = toolResultContent([cacheItem as unknown]);
            assert.strictEqual(result, "Success");
        } finally {
            teardown();
        }
    });

    // ── Branch: VS Code native DataPart with non-cache-control MIME ────────

    test("returns base64 data for DataPart with non-cache-control MIME type", () => {
        const teardown = installVSCodeGlobal({ LanguageModelDataPart: MockDataPart });
        try {
            const binaryData = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
            const dataItem = new MockDataPart("image/png", binaryData);
            const result = toolResultContent([dataItem as unknown]);
            // Single non-text item → JSON envelope
            const parsed = JSON.parse(result) as { type: string; content: unknown[] };
            assert.strictEqual(parsed.type, "tool_result");
            assert.ok(Array.isArray(parsed.content));
            assert.strictEqual(parsed.content.length, 1);
            const item = parsed.content[0] as { type: string; mimeType: string; data: string };
            assert.strictEqual(item.type, "data");
            assert.strictEqual(item.mimeType, "image/png");
            assert.strictEqual(item.data, Buffer.from(binaryData).toString("base64"));
        } finally {
            teardown();
        }
    });

    test("encodes empty binary DataPart data as empty base64 string", () => {
        const teardown = installVSCodeGlobal({ LanguageModelDataPart: MockDataPart });
        try {
            const emptyData = new MockDataPart("application/octet-stream", new Uint8Array(0));
            const result = toolResultContent([emptyData as unknown]);
            const parsed = JSON.parse(result) as { content: { data: string }[] };
            assert.strictEqual(parsed.content[0].data, "");
        } finally {
            teardown();
        }
    });

    // ── Branch: undefined items ────────────────────────────────────────────

    test("drops undefined items from tool result content", () => {
        // undefined items are filtered out by serializeToolResultContent
        const result = toolResultContent([undefined]);
        assert.strictEqual(result, "Success");
    });

    test("drops undefined items but keeps other items", () => {
        const result = toolResultContent([undefined, "valid text", undefined]);
        // After filtering: ["valid text"] → single text → unwrapped
        assert.strictEqual(result, "valid text");
    });

    // ── Branch: JSON objects / other structures ────────────────────────────

    test("returns JSON value for plain object items", () => {
        const obj = { key: "value", nested: { a: 1 } };
        const result = toolResultContent([obj]);
        const parsed = JSON.parse(result) as { type: string; content: unknown[] };
        assert.strictEqual(parsed.type, "tool_result");
        const item = parsed.content[0] as { type: string; value: unknown };
        assert.strictEqual(item.type, "json");
        assert.deepStrictEqual(item.value, obj);
    });

    test("returns JSON value for null items (not treated as undefined)", () => {
        const result = toolResultContent([null]);
        // null !== undefined, so it's serialized as { type: "json", value: null }
        const parsed = JSON.parse(result) as { content: { type: string; value: unknown }[] };
        assert.strictEqual(parsed.content[0].type, "json");
        assert.strictEqual(parsed.content[0].value, null);
    });

    test("returns JSON value for number items", () => {
        const result = toolResultContent([42]);
        const parsed = JSON.parse(result) as { content: { type: string; value: unknown }[] };
        assert.strictEqual(parsed.content[0].type, "json");
        assert.strictEqual(parsed.content[0].value, 42);
    });

    test("returns JSON value for boolean items", () => {
        const result = toolResultContent([true]);
        const parsed = JSON.parse(result) as { content: { type: string; value: unknown }[] };
        assert.strictEqual(parsed.content[0].type, "json");
        assert.strictEqual(parsed.content[0].value, true);
    });

    test("returns JSON value for array items", () => {
        const arr = [1, "two", { three: 3 }];
        const result = toolResultContent([arr]);
        const parsed = JSON.parse(result) as { content: { type: string; value: unknown }[] };
        assert.strictEqual(parsed.content[0].type, "json");
        assert.deepStrictEqual(parsed.content[0].value, arr);
    });

    // ── Branch: globalThis.vscode not set (no VS Code constructors) ────────

    test("handles plain strings when VS Code global is unavailable", () => {
        // Ensure globalThis.vscode is not set
        const teardown = installVSCodeGlobal({});
        try {
            const result = toolResultContent(["text without vscode global"]);
            assert.strictEqual(result, "text without vscode global");
        } finally {
            teardown();
        }
    });

    test("handles objects when VS Code global is unavailable", () => {
        const teardown = installVSCodeGlobal({});
        try {
            const obj = { answer: 42 };
            const result = toolResultContent([obj]);
            const parsed = JSON.parse(result) as { content: { type: string; value: unknown }[] };
            assert.strictEqual(parsed.content[0].type, "json");
            assert.deepStrictEqual(parsed.content[0].value, obj);
        } finally {
            teardown();
        }
    });

    test("handles items as plain objects when VS Code global is undefined (no globalThis.vscode)", () => {
        // Remove globalThis.vscode entirely
        const g = globalThis as Record<string, unknown>;
        const saved = g.vscode;
        delete g.vscode;
        try {
            const result = toolResultContent([{ fallback: true }]);
            const parsed = JSON.parse(result) as { content: { type: string; value: unknown }[] };
            assert.strictEqual(parsed.content[0].type, "json");
            assert.deepStrictEqual(parsed.content[0].value, { fallback: true });
        } finally {
            if (saved !== undefined) {
                g.vscode = saved;
            }
        }
    });

    // ── serializeToolResultContent edge cases ──────────────────────────────

    test("returns 'Success' when tool result content is empty array", () => {
        const result = toolResultContent([]);
        assert.strictEqual(result, "Success");
    });

    test("returns unwrapped text for single text item", () => {
        const result = toolResultContent(["only text"]);
        assert.strictEqual(result, "only text");
    });

    test("returns JSON envelope for multiple text items", () => {
        const result = toolResultContent(["first", "second"]);
        const parsed = JSON.parse(result) as { type: string; content: { type: string; text: string }[] };
        assert.strictEqual(parsed.type, "tool_result");
        assert.strictEqual(parsed.content.length, 2);
        assert.strictEqual(parsed.content[0].type, "text");
        assert.strictEqual(parsed.content[0].text, "first");
        assert.strictEqual(parsed.content[1].type, "text");
        assert.strictEqual(parsed.content[1].text, "second");
    });

    test("returns JSON envelope for mixed content types (text + json object)", () => {
        const result = toolResultContent(["some text", { key: "val" }]);
        const parsed = JSON.parse(result) as { type: string; content: unknown[] };
        assert.strictEqual(parsed.type, "tool_result");
        assert.strictEqual(parsed.content.length, 2);
        const textItem = parsed.content[0] as { type: string; text: string };
        assert.strictEqual(textItem.type, "text");
        assert.strictEqual(textItem.text, "some text");
        const jsonItem = parsed.content[1] as { type: string; value: unknown };
        assert.strictEqual(jsonItem.type, "json");
        assert.deepStrictEqual(jsonItem.value, { key: "val" });
    });

    // ── Branch: string checked before DataPart (ordering) ─────────────────

    test("string items are matched before DataPart check even when both constructors are available", () => {
        const teardown = installVSCodeGlobal({
            LanguageModelTextPart: MockTextPart,
            LanguageModelDataPart: MockDataPart,
        });
        try {
            // A plain string is not an instance of MockDataPart, so it
            // must still be handled by the typeof === "string" branch.
            const result = toolResultContent(["string-before-data"]);
            assert.strictEqual(result, "string-before-data");
        } finally {
            teardown();
        }
    });

    // ── Branch: TextPart matched before DataPart (ordering) ────────────────

    test("TextPart instances are matched before string/DataPart checks", () => {
        const teardown = installVSCodeGlobal({
            LanguageModelTextPart: MockTextPart,
            LanguageModelDataPart: MockDataPart,
        });
        try {
            // TextPart constructor is checked first; this object is an
            // instance of MockTextPart, so it returns text from .value.
            const textPart = new MockTextPart("from-textpart");
            const result = toolResultContent([textPart as unknown]);
            assert.strictEqual(result, "from-textpart");
        } finally {
            teardown();
        }
    });

    // ── Mixed content: multiple items of different types ───────────────────

    test("handles mixed content with text, object, and undefined items", () => {
        const result = toolResultContent(["hello", undefined, { data: 123 }, "world"]);
        // After filtering: ["hello", { data: 123 }, "world"] → 3 items → JSON envelope
        const parsed = JSON.parse(result) as { type: string; content: unknown[] };
        assert.strictEqual(parsed.type, "tool_result");
        assert.strictEqual(parsed.content.length, 3);
        const first = parsed.content[0] as { type: string; text: string };
        assert.strictEqual(first.type, "text");
        assert.strictEqual(first.text, "hello");
        const second = parsed.content[1] as { type: string; value: unknown };
        assert.strictEqual(second.type, "json");
        assert.deepStrictEqual(second.value, { data: 123 });
        const third = parsed.content[2] as { type: string; text: string };
        assert.strictEqual(third.type, "text");
        assert.strictEqual(third.text, "world");
    });

    // ── Buffer/encoding edge case ──────────────────────────────────────────

    test("correctly base64-encodes binary DataPart with multi-byte UTF-8 data", () => {
        const teardown = installVSCodeGlobal({ LanguageModelDataPart: MockDataPart });
        try {
            // Multi-byte UTF-8: " café " in bytes
            const utf8Bytes = new Uint8Array([0xc3, 0xa9]); // é
            const dataItem = new MockDataPart("application/octet-stream", utf8Bytes);
            const result = toolResultContent([dataItem as unknown]);
            const parsed = JSON.parse(result) as { content: { data: string }[] };
            assert.strictEqual(parsed.content[0].data, Buffer.from(utf8Bytes).toString("base64"));
        } finally {
            teardown();
        }
    });

    // ── normalizeToolCallId is called on the tool_result callId ────────────

    test("normalizes tool_result callId via options.normalizeToolCallId", () => {
        const normalizerCalls: string[] = [];
        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => {
                normalizerCalls.push(id);
                return `norm_${id}`;
            },
        };

        const message = toolResultMessage("raw-call-id", ["result text"]);
        const result = convertMessagesToOpenAI([message], options);
        const toolMsg = result.find((m) => m.role === "tool");
        assert.ok(toolMsg, "Expected tool message");
        assert.strictEqual(toolMsg.tool_call_id, "norm_raw-call-id");
        assert.ok(normalizerCalls.includes("raw-call-id"), "Expected normalizer to be called with raw callId");
    });
});

// ── new suite: appendDataPart via convertMessagesToOpenAI ────────────────────

suite("Message Converters — appendDataPart (via convertMessagesToOpenAI)", () => {
    /**
     * Helper: build a V2ChatMessage with a single data part.
     */
    function dataMessage(mimeType: string, data: Uint8Array): V2ChatMessage {
        return {
            role: "user",
            name: undefined,
            content: [{ type: "data", mimeType, data }],
        };
    }

    // ── Branch 1: cache-control MIME → dropped ────────────────────────────

    test("drops data part with 'cache_control' MIME type and emits no message", () => {
        const result = convertMessagesToOpenAI(
            [dataMessage("cache_control", new Uint8Array([1, 2, 3]))],
            defaultOptions
        );
        // The only content was a cache-control part → nothing to flush → 0 messages
        assert.strictEqual(result.length, 0);
    });

    test("drops data part with 'application/vnd.anthropic.cache-control+json' MIME type", () => {
        const result = convertMessagesToOpenAI(
            [dataMessage("application/vnd.anthropic.cache-control+json", new Uint8Array([0]))],
            defaultOptions
        );
        assert.strictEqual(result.length, 0);
    });

    test("drops data part with MIME type containing 'cache_control' (underscore variant)", () => {
        const result = convertMessagesToOpenAI(
            [dataMessage("text/x-cache_control", new Uint8Array([42]))],
            defaultOptions
        );
        assert.strictEqual(result.length, 0);
    });

    // ── Branch 2: image MIME → image_url content item ─────────────────────

    test("converts image/png data part to image_url with base64 data URI", () => {
        const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
        const result = convertMessagesToOpenAI([dataMessage("image/png", binaryData)], defaultOptions);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].role, "user");
        assert.ok(Array.isArray(result[0].content), "Expected content array for image");
        const items = result[0].content;
        assert.strictEqual(items.length, 1);
        const item = items[0] as { type: string; image_url: { url: string } };
        assert.strictEqual(item.type, "image_url");
        assert.strictEqual(item.image_url.url, `data:image/png;base64,${Buffer.from(binaryData).toString("base64")}`);
    });

    test("converts image/jpeg data part to image_url content item", () => {
        const jpegData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
        const result = convertMessagesToOpenAI([dataMessage("image/jpeg", jpegData)], defaultOptions);
        const item = (result[0].content as { type: string; image_url: { url: string } }[])[0];
        assert.strictEqual(item.type, "image_url");
        assert.ok(item.image_url.url.startsWith("data:image/jpeg;base64,"));
    });

    test("converts image/gif data part to image_url content item", () => {
        const gifData = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
        const result = convertMessagesToOpenAI([dataMessage("image/gif", gifData)], defaultOptions);
        const item = (result[0].content as { type: string; image_url: { url: string } }[])[0];
        assert.strictEqual(item.type, "image_url");
        assert.ok(item.image_url.url.startsWith("data:image/gif;base64,"));
    });

    test("converts image/webp data part to image_url content item", () => {
        const webpData = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
        const result = convertMessagesToOpenAI([dataMessage("image/webp", webpData)], defaultOptions);
        const item = (result[0].content as { type: string; image_url: { url: string } }[])[0];
        assert.strictEqual(item.type, "image_url");
        assert.ok(item.image_url.url.startsWith("data:image/webp;base64,"));
    });

    test("converts empty image data part to image_url with empty base64 string", () => {
        const result = convertMessagesToOpenAI([dataMessage("image/png", new Uint8Array(0))], defaultOptions);
        const item = (result[0].content as { type: string; image_url: { url: string } }[])[0];
        assert.strictEqual(item.type, "image_url");
        assert.strictEqual(item.image_url.url, "data:image/png;base64,");
    });

    // ── Branch 3: text MIME → decoded UTF-8 appended to textParts ─────────

    test("decodes text/plain data part as UTF-8 text content", () => {
        const textBytes = new Uint8Array(Buffer.from("Hello from data part"));
        const result = convertMessagesToOpenAI([dataMessage("text/plain", textBytes)], defaultOptions);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].role, "user");
        assert.strictEqual(result[0].content, "Hello from data part");
    });

    test("decodes text/html data part as UTF-8 text content", () => {
        const htmlBytes = new Uint8Array(Buffer.from("<b>bold</b>"));
        const result = convertMessagesToOpenAI([dataMessage("text/html", htmlBytes)], defaultOptions);
        assert.strictEqual(result[0].content, "<b>bold</b>");
    });

    test("decodes text/csv data part as UTF-8 text content", () => {
        const csvBytes = new Uint8Array(Buffer.from("a,b,c\n1,2,3"));
        const result = convertMessagesToOpenAI([dataMessage("text/csv", csvBytes)], defaultOptions);
        assert.strictEqual(result[0].content, "a,b,c\n1,2,3");
    });

    test("decodes empty text data part as empty string (produces no message)", () => {
        const result = convertMessagesToOpenAI([dataMessage("text/plain", new Uint8Array(0))], defaultOptions);
        // Empty text → textParts=[""] → buildMessageContent returns undefined → no message
        assert.strictEqual(result.length, 0);
    });

    test("decodes text data part with multi-byte UTF-8 characters correctly", () => {
        const utf8Bytes = new Uint8Array(Buffer.from("café résumé 日本語"));
        const result = convertMessagesToOpenAI([dataMessage("text/plain", utf8Bytes)], defaultOptions);
        assert.strictEqual(result[0].content, "café résumé 日本語");
    });

    // ── Branch 4: JSON MIME → decoded UTF-8 appended to textParts ─────────

    test("decodes application/json data part as UTF-8 text content", () => {
        const jsonBytes = new Uint8Array(Buffer.from('{"key":"value"}'));
        const result = convertMessagesToOpenAI([dataMessage("application/json", jsonBytes)], defaultOptions);
        assert.strictEqual(result[0].content, '{"key":"value"}');
    });

    test("decodes application/vnd.api+json data part as UTF-8 text content", () => {
        const jsonBytes = new Uint8Array(Buffer.from('{"data":[]}'));
        const result = convertMessagesToOpenAI([dataMessage("application/vnd.api+json", jsonBytes)], defaultOptions);
        assert.strictEqual(result[0].content, '{"data":[]}');
    });

    test("decodes text/json data part as UTF-8 text content", () => {
        const jsonBytes = new Uint8Array(Buffer.from("[1,2,3]"));
        const result = convertMessagesToOpenAI([dataMessage("text/json", jsonBytes)], defaultOptions);
        assert.strictEqual(result[0].content, "[1,2,3]");
    });

    // ── Branch 5: unrecognized MIME → silently dropped ────────────────────

    test("silently drops data part with unrecognized MIME type (e.g. application/octet-stream)", () => {
        const result = convertMessagesToOpenAI(
            [dataMessage("application/octet-stream", new Uint8Array([1, 2, 3]))],
            defaultOptions
        );
        // Falls through all branches → nothing appended → no message emitted
        assert.strictEqual(result.length, 0);
    });

    test("silently drops data part with application/pdf MIME type", () => {
        const result = convertMessagesToOpenAI(
            [dataMessage("application/pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46]))],
            defaultOptions
        );
        assert.strictEqual(result.length, 0);
    });

    // ── Mixed content: data + text in same message ────────────────────────

    test("combines text part and text/* data part in the same message", () => {
        const message: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                { type: "text", text: "Before data. " },
                { type: "data", mimeType: "text/plain", data: new Uint8Array(Buffer.from("After data.")) },
            ],
        };
        const result = convertMessagesToOpenAI([message], defaultOptions);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].content, "Before data. After data.");
    });

    test("combines text part and image data part into content items array", () => {
        const imageData = new Uint8Array([0x89, 0x50]);
        const message: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                { type: "text", text: "Look at this image:" },
                { type: "data", mimeType: "image/png", data: imageData },
            ],
        };
        const result = convertMessagesToOpenAI([message], defaultOptions);
        assert.strictEqual(result.length, 1);
        assert.ok(Array.isArray(result[0].content), "Expected content array");
        const items = result[0].content as { type: string }[];
        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].type, "text");
        assert.strictEqual(items[1].type, "image_url");
    });

    test("combines image data part with no preceding text into content items array", () => {
        const imageData = new Uint8Array([0x89, 0x50]);
        const message: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                { type: "data", mimeType: "image/png", data: imageData },
                { type: "text", text: "Caption" },
            ],
        };
        const result = convertMessagesToOpenAI([message], defaultOptions);
        assert.strictEqual(result.length, 1);
        const items = result[0].content as { type: string }[];
        // buildMessageContent puts text first, then contentItems (image_url)
        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].type, "text");
        assert.strictEqual(items[1].type, "image_url");
    });

    test("handles multiple image data parts in the same message", () => {
        const img1 = new Uint8Array([0x89, 0x50]);
        const img2 = new Uint8Array([0xff, 0xd8]);
        const message: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                { type: "data", mimeType: "image/png", data: img1 },
                { type: "data", mimeType: "image/jpeg", data: img2 },
            ],
        };
        const result = convertMessagesToOpenAI([message], defaultOptions);
        const items = result[0].content as { type: string; image_url: { url: string } }[];
        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].type, "image_url");
        assert.ok(items[0].image_url.url.startsWith("data:image/png;base64,"));
        assert.strictEqual(items[1].type, "image_url");
        assert.ok(items[1].image_url.url.startsWith("data:image/jpeg;base64,"));
    });

    // ── Mixed content: cache-control data part dropped among other parts ──

    test("drops cache-control data part but keeps adjacent text and image parts", () => {
        const imageData = new Uint8Array([0x89, 0x50]);
        const message: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                { type: "text", text: "Here is an image:" },
                { type: "data", mimeType: "cache_control", data: new Uint8Array([0]) },
                { type: "data", mimeType: "image/png", data: imageData },
            ],
        };
        const result = convertMessagesToOpenAI([message], defaultOptions);
        assert.strictEqual(result.length, 1);
        const items = result[0].content as { type: string }[];
        // text + image_url (cache_control was dropped)
        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].type, "text");
        assert.strictEqual(items[1].type, "image_url");
    });

    // ── Edge case: all data parts dropped → no message ────────────────────

    test("emits no message when all data parts are cache-control", () => {
        const message: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                { type: "data", mimeType: "cache_control", data: new Uint8Array([1]) },
                { type: "data", mimeType: "application/vnd.anthropic.cache-control+json", data: new Uint8Array([2]) },
            ],
        };
        const result = convertMessagesToOpenAI([message], defaultOptions);
        assert.strictEqual(result.length, 0);
    });

    // ── Edge case: data part with unrecognized MIME among text parts ───────

    test("drops unrecognized data part but keeps adjacent text parts", () => {
        const message: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                { type: "text", text: "before " },
                { type: "data", mimeType: "application/octet-stream", data: new Uint8Array([1, 2, 3]) },
                { type: "text", text: "after" },
            ],
        };
        const result = convertMessagesToOpenAI([message], defaultOptions);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].content, "before after");
    });

    // ── Edge case: assistant role with data part ──────────────────────────

    test("handles data part in assistant-role message", () => {
        const message: V2ChatMessage = {
            role: "assistant",
            name: undefined,
            content: [
                { type: "text", text: "I processed: " },
                { type: "data", mimeType: "text/plain", data: new Uint8Array(Buffer.from("result")) },
            ],
        };
        const result = convertMessagesToOpenAI([message], defaultOptions);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].role, "assistant");
        assert.strictEqual(result[0].content, "I processed: result");
    });
});

/**
 * Test suite for tool result ID preservation and Bedrock compatibility.
 *
 * Bedrock's Converse API validation requires:
 * 1. Tool result callId matches preceding assistant tool_call id
 * 2. Tool result content is present and well-formed
 * 3. Tool call IDs remain stable across normalization
 */
suite("Message Converters — Tool Result ID Preservation (Bedrock Compatibility)", () => {
    test("preserves tool call ID in tool result message (exact match with normalization)", () => {
        const callId = "call-abc-123-xyz";
        const message: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                {
                    type: "tool_result",
                    callId,
                    content: ["Tool result text"],
                },
            ],
        };

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => `normalized_${id}`,
        };

        const result = convertMessagesToOpenAI([message], options);
        const toolMsg = result.find((m) => m.role === "tool");

        assert.ok(toolMsg, "Expected a tool-role message in output");
        assert.strictEqual(
            toolMsg.tool_call_id,
            `normalized_${callId}`,
            "Tool result tool_call_id should match normalized call ID"
        );
    });

    test("ensures tool result appears after assistant tool call in message sequence", () => {
        const toolCallId = "call-xyz";
        const messages: V2ChatMessage[] = [
            {
                role: "assistant",
                name: undefined,
                content: [
                    {
                        type: "tool_call",
                        callId: toolCallId,
                        name: "search_tool",
                        input: {},
                    },
                ],
            },
            {
                role: "user",
                name: undefined,
                content: [
                    {
                        type: "tool_result",
                        callId: toolCallId,
                        content: ["Found results"],
                    },
                ],
            },
        ];

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => id,
        };

        const result = convertMessagesToOpenAI(messages, options);

        // Verify sequence: assistant (with tool_call) → tool (with matching tool_call_id)
        const toolCallMsg = result.find((m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0);
        const toolResultMsg = result.find((m) => m.role === "tool");

        assert.ok(toolCallMsg, "Expected assistant message with tool call");
        assert.ok(toolResultMsg, "Expected tool message");

        const toolCallMsgIndex = result.indexOf(toolCallMsg);
        const toolResultMsgIndex = result.indexOf(toolResultMsg);

        assert.ok(
            toolResultMsgIndex > toolCallMsgIndex,
            `Tool result message should come after assistant tool call (indices: ${toolCallMsgIndex} → ${toolResultMsgIndex})`
        );

        assert.strictEqual(
            toolCallMsg.tool_calls![0].id,
            toolResultMsg.tool_call_id,
            "Tool call ID and tool result call_id must match exactly"
        );
    });

    test("validates tool result ID format for provider compatibility", () => {
        // Bedrock's toolUse IDs require alphanumeric + underscore/dash pattern
        const callId = "call-abc-123";
        const message: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                {
                    type: "tool_result",
                    callId,
                    content: ["result"],
                },
            ],
        };

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => {
                // Simulate Bedrock ID normalization: strip invalid chars, keep alphanumeric + underscore/dash
                return id.replace(/[^a-zA-Z0-9_-]/g, "");
            },
        };

        const result = convertMessagesToOpenAI([message], options);
        const toolMsg = result.find((m) => m.role === "tool");

        assert.ok(toolMsg, "Expected tool-role message");
        assert.ok(
            /^[a-zA-Z0-9_-]+$/.test(toolMsg.tool_call_id!),
            `Normalized ID should contain only alphanumeric, dash, underscore; got: ${toolMsg.tool_call_id}`
        );
    });

    test("handles multiple tool calls and results in correct sequence (Bedrock ordering)", () => {
        const callId1 = "call-1";
        const callId2 = "call-2";

        const messages: V2ChatMessage[] = [
            {
                role: "assistant",
                name: undefined,
                content: [
                    {
                        type: "tool_call",
                        callId: callId1,
                        name: "func1",
                        input: {},
                    },
                    {
                        type: "tool_call",
                        callId: callId2,
                        name: "func2",
                        input: {},
                    },
                ],
            },
            {
                role: "user",
                name: undefined,
                content: [
                    {
                        type: "tool_result",
                        callId: callId1,
                        content: ["result 1"],
                    },
                    {
                        type: "tool_result",
                        callId: callId2,
                        content: ["result 2"],
                    },
                ],
            },
        ];

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => id,
        };

        const result = convertMessagesToOpenAI(messages, options);

        const toolResults = result.filter((m) => m.role === "tool");
        assert.strictEqual(toolResults.length, 2, "Expected 2 tool result messages");
        assert.strictEqual(toolResults[0].tool_call_id, callId1, "First result should match first call");
        assert.strictEqual(toolResults[1].tool_call_id, callId2, "Second result should match second call");
    });

    test("ensures tool result content is never empty (defaults to 'Success')", () => {
        const callId = "call-empty";
        const message: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                {
                    type: "tool_result",
                    callId,
                    content: [], // Empty content array
                },
            ],
        };

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => id,
        };

        const result = convertMessagesToOpenAI([message], options);
        const toolMsg = result.find((m) => m.role === "tool");

        assert.ok(toolMsg, "Expected tool-role message");
        assert.ok(toolMsg.content, "Tool result content should never be undefined or null");
        assert.strictEqual(toolMsg.content, "Success", "Empty tool result should default to 'Success'");
    });
});
