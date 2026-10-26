import * as assert from "assert";
import {
    createReasoningScope,
    extractResponsesReasoning,
    isNativeResponsesModel,
    readResponsesReasoningItem,
    RESPONSES_REASONING_METADATA,
} from "../reasoningContinuity";

suite("Native Responses reasoning continuity", () => {
    test("native detection requires a known OpenAI family, not just OpenAI-compatible transport", () => {
        const native: [string, Parameters<typeof isNativeResponsesModel>[1]][] = [
            ["openai/gpt-5.4", undefined],
            ["openai/responses/gpt-5.4", undefined],
            ["openai/o3-mini", undefined],
            ["gpt-5.4", { provider: "openai" }],
            ["openai/gpt-5.4", { key: "gpt-5.4" }],
            ["private-alias", { provider: "openai", key: "gpt-5.4" }],
            ["private-alias", { provider: "chatgpt" }],
            ["chatgpt/private-alias", undefined],
        ];
        const bridged: [string, Parameters<typeof isNativeResponsesModel>[1]][] = [
            ["qwen3-coder-480b-a35b-instruct", { provider: "openai" }],
            ["openai/mistral-31-24b", undefined],
            ["private-alias", { provider: "openai" }],
            ["openai/gpt-5.4", { provider: "azure_ai" }],
            ["openai/gpt-5.4", { provider: "openai", key: "mistral-31-24b" }],
        ];
        for (const [model, info] of native) {
            assert.strictEqual(isNativeResponsesModel(model, info), true, model);
        }
        for (const [model, info] of bridged) {
            assert.strictEqual(isNativeResponsesModel(model, info), false, model);
        }
    });

    test("scope fails closed without authorization or with an unsafe backend URL", () => {
        assert.strictEqual(createReasoningScope("chatgpt/model", "https://proxy.example"), undefined);
        for (const backend of [
            undefined,
            "invalid",
            "file:///tmp",
            "https://u:p@proxy.example",
            "https://p.example?k=1",
        ]) {
            assert.strictEqual(createReasoningScope("chatgpt/model", backend, "group", "session"), undefined);
        }
        assert.deepStrictEqual(createReasoningScope("chatgpt/model", "https://PROXY.example/team//", "g", "s"), {
            model: "chatgpt/model",
            backend: "https://proxy.example/team",
            group: "g",
            authorization: "s",
        });
    });

    test("metadata written before authorization scoping is never replayed", () => {
        const part = {
            metadata: {
                [RESPONSES_REASONING_METADATA]: {
                    version: 1,
                    source: { model: "chatgpt/model", backend: "https://proxy.example" },
                    item: { type: "reasoning", id: "rs_old", summary: [], encrypted_content: "STATE" },
                },
            },
        };
        const target = createReasoningScope("chatgpt/model", "https://proxy.example", undefined, "session");
        assert.strictEqual(extractResponsesReasoning(part, target), undefined);
    });

    test("item validation copies only protocol fields", () => {
        const item = { type: "reasoning", id: "rs_valid", summary: [], encrypted_content: "STATE" };
        assert.deepStrictEqual(readResponsesReasoningItem({ ...item, arbitrary: "dropped" }), item);
        for (const invalid of [
            null,
            { ...item, id: "not-rs" },
            { ...item, encrypted_content: "" },
            { ...item, status: "failed" },
            { ...item, summary: [{ type: "text", text: "wrong" }] },
        ]) {
            assert.strictEqual(readResponsesReasoningItem(invalid), undefined);
        }
    });
});
