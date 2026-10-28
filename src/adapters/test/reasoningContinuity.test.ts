import * as assert from "assert";
import {
    createReasoningScope,
    extractResponsesReasoning,
    isNativeResponsesModel,
    readResponsesReasoningEnvelope,
    readResponsesReasoningItem,
    RESPONSES_REASONING_METADATA,
    thinkingPartId,
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
            assert.strictEqual(isNativeResponsesModel(model, { ...info, supports_reasoning: true }), true, model);
        }
        for (const [model, info] of bridged) {
            assert.strictEqual(isNativeResponsesModel(model, { ...info, supports_reasoning: true }), false, model);
        }
    });

    test("native reasoning requires an explicit supports_reasoning: true", () => {
        // Real LiteLLM cards list `reasoning_effort` in supported_openai_params for gpt-4o,
        // gpt-4.1 and gpt-3.5 too (supports_reasoning: null), so that param proves nothing.
        const cardLike = { supported_openai_params: ["reasoning_effort", "temperature", "tools"] };
        for (const model of ["openai/gpt-4o", "openai/gpt-4.1", "chatgpt/gpt-6.1-sol"]) {
            for (const supports_reasoning of [undefined, null, false]) {
                assert.strictEqual(isNativeResponsesModel(model, { ...cardLike, supports_reasoning }), false, model);
            }
        }
        // A lone effort flag (live: openai/gpt-5-search-api) is not proof either.
        assert.strictEqual(
            isNativeResponsesModel("openai/gpt-5-search-api", { ...cardLike, supports_minimal_reasoning_effort: true }),
            false
        );
        assert.strictEqual(
            isNativeResponsesModel("openai/gpt-5-nano", { ...cardLike, supports_reasoning: true }),
            true
        );
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

    test("unscoped envelope parsing validates the item but never authorizes replay", () => {
        const item = { type: "reasoning", id: "rs_valid", summary: [], encrypted_content: "STATE" };
        const part = { metadata: { [RESPONSES_REASONING_METADATA]: { version: 1, item } } };
        assert.deepStrictEqual(readResponsesReasoningEnvelope(part)?.item, item);
        assert.strictEqual(
            extractResponsesReasoning(part, createReasoningScope("chatgpt/model", "https://proxy.example", "g", "s")),
            undefined
        );
        for (const value of [null, [], {}, { version: 2, item }, { version: 1, item: { ...item, summary: [null] } }]) {
            assert.strictEqual(
                readResponsesReasoningEnvelope({ metadata: { [RESPONSES_REASONING_METADATA]: value } }),
                undefined
            );
        }
        assert.strictEqual(thinkingPartId({ id: "rs_valid", value: "delta" }), "rs_valid");
        for (const value of [null, [], { id: "rs_valid" }, { id: 1, value: "delta" }]) {
            assert.strictEqual(thinkingPartId(value), undefined);
        }
    });
});
