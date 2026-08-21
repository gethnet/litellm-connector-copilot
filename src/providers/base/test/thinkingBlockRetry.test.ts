import * as assert from "assert";
import {
    isThinkingBlockRetryableError,
    requestHasThinkingBlocks,
    stripThinkingBlocksFromRequest,
} from "../thinkingBlockRetry";
import type { OpenAIChatCompletionRequest } from "../../../types";

function httpError(message: string, status: number): Error & { status: number } {
    const error = new Error(message) as Error & { status: number };
    error.status = status;
    return error;
}

suite("thinkingBlockRetry", () => {
    const request: OpenAIChatCompletionRequest = {
        model: "claude-opus-5",
        stream: true,
        reasoning_effort: "high",
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        stream_options: { include_usage: true },
        extra_body: { cache: { "no-cache": true } },
        messages: [
            { role: "user", content: "hi" },
            {
                role: "assistant",
                content: "answer",
                thinking_blocks: [
                    {
                        type: "thinking",
                        thinking: "prior reasoning",
                        signature: "signature-from-old-model",
                    },
                ],
            },
        ],
    };

    test("detects only non-empty thinking_blocks arrays", () => {
        assert.strictEqual(requestHasThinkingBlocks(request), true);
        assert.strictEqual(
            requestHasThinkingBlocks({ model: "m", messages: [{ role: "assistant", thinking_blocks: [] }] }),
            false
        );
        assert.strictEqual(
            requestHasThinkingBlocks({ model: "m", messages: [{ role: "user", content: "hi" }] }),
            false
        );
    });

    test("strips only message continuity and preserves native reasoning fields", () => {
        const redacted = stripThinkingBlocksFromRequest(request);

        assert.notStrictEqual(redacted, request);
        assert.notStrictEqual(redacted.messages, request.messages);
        assert.strictEqual("thinking_blocks" in redacted.messages[1], false);
        assert.strictEqual(redacted.reasoning_effort, "high");
        assert.deepStrictEqual(redacted.thinking, { type: "adaptive" });
        assert.deepStrictEqual(redacted.output_config, { effort: "high" });
        assert.deepStrictEqual(redacted.stream_options, { include_usage: true });
        assert.deepStrictEqual(redacted.extra_body, { cache: { "no-cache": true } });
        assert.ok(request.messages[1].thinking_blocks, "original request must remain unchanged");
    });

    test("classifies provider-specific HTTP 400 continuity rejections", () => {
        const errors = [
            httpError("Invalid `signature` in `thinking` block", 400),
            httpError("thinking_blocks is not supported by this model", 400),
            new Error("LiteLLM API error: 400 Bad Request\nunknown parameter: thinking_blocks"),
            new Error("LiteLLM API error: 400 Bad Request\nmessages.1.content.0.thinking.signature: invalid value"),
            new Error("LiteLLM API error: 400 Bad Request\nmessages.1.content.0.type: Field required"),
        ];

        for (const error of errors) {
            assert.strictEqual(isThinkingBlockRetryableError(error), true, error.message);
        }
    });

    test("rejects unrelated or unsafe retry classes", () => {
        const errors = [
            httpError("invalid api key", 401),
            httpError("forbidden", 403),
            httpError("rate limited", 429),
            httpError("context length exceeded", 400),
            httpError("internal server error mentioning thinking", 500),
            new Error("network timeout while sending thinking_blocks"),
            new Error("No baseUrl provided in call-time configuration"),
        ];

        for (const error of errors) {
            assert.strictEqual(isThinkingBlockRetryableError(error), false, error.message);
        }
    });
});
