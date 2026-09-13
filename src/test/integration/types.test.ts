import * as assert from "assert";

import type {
    LiteLLMConfig,
    LiteLLMModelInfo,
    LiteLLMResponseInputItem,
    LiteLLMResponsesContentItem,
    LiteLLMResponsesRequest,
    OpenAIChatCompletionRequest,
    OpenAIChatMessage,
    OpenAIToolCall,
} from "../../types";

suite("Types Unit Tests", () => {
    test("LiteLLMConfig supports commit model id override", () => {
        const cfg: LiteLLMConfig = {
            commitModelIdOverride: "gpt-4",
        };

        assert.strictEqual(cfg.commitModelIdOverride, "gpt-4");
    });

    test("OpenAIChatCompletionRequest shape is assignable", () => {
        const msg: OpenAIChatMessage = { role: "user", content: "hi" };
        const req: OpenAIChatCompletionRequest = {
            model: "m",
            messages: [msg],
            stream: true,
            extra_body: { cache: { "no-cache": true } },
        };

        assert.strictEqual(req.model, "m");
        assert.strictEqual(req.messages[0].role, "user");
        assert.strictEqual(req.stream, true);
        assert.strictEqual(req.extra_body?.cache?.["no-cache"], true);
    });

    test("LiteLLMResponseInputItem union accepts message and tool items", () => {
        const a: LiteLLMResponseInputItem = { type: "message", role: "user", content: "x" };
        const b: LiteLLMResponseInputItem = {
            type: "function_call",
            id: "id1",
            name: "tool",
            arguments: "{}",
        };
        const c: LiteLLMResponseInputItem = { type: "function_call_output", call_id: "c1", output: "ok" };

        assert.strictEqual(a.type, "message");
        assert.strictEqual(b.type, "function_call");
        assert.strictEqual(c.type, "function_call_output");
    });

    test("LiteLLMResponseInputItem message content accepts Responses-native parts (#154)", () => {
        const parts: LiteLLMResponsesContentItem[] = [
            { type: "input_text", text: "hello", cache_control: { type: "ephemeral" } },
            { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
            { type: "input_file", filename: "doc.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
        ];
        const message: LiteLLMResponseInputItem = { type: "message", role: "user", content: parts };
        const request: LiteLLMResponsesRequest = { model: "m", input: [message], max_output_tokens: 42 };

        assert.strictEqual(message.type, "message");
        assert.strictEqual(request.max_output_tokens, 42);
        assert.strictEqual(request.input.length, 1);
        assert.ok(Array.isArray(message.content));
    });

    test("LiteLLMModelInfo index signature allows extra fields", () => {
        const info: LiteLLMModelInfo = {
            supports_function_calling: true,
            max_input_tokens: 123,
            some_new_field: "ok",
        };

        assert.strictEqual(info.supports_function_calling, true);
        assert.strictEqual(info.max_input_tokens, 123);
        assert.strictEqual(info.some_new_field, "ok");
    });

    test("OpenAIToolCall is assignable", () => {
        const tc: OpenAIToolCall = {
            id: "call_1",
            type: "function",
            function: { name: "t", arguments: "{}" },
        };
        assert.strictEqual(tc.type, "function");
        assert.strictEqual(tc.function.name, "t");
    });
});
