import * as assert from "assert";

import { canonicalizeModelInfoResponse, hashModelInfoResponseAsync } from "../discoveryHash";

suite("discoveryHash", () => {
    test("identical_responses_produce_identical_hash", async () => {
        const response = {
            data: [
                {
                    model_name: "gpt-4.1",
                    model_info: { supports_reasoning: true, input_cost_per_token: 0.00001 },
                },
            ],
        };

        const hash1 = await hashModelInfoResponseAsync(response);
        const hash2 = await hashModelInfoResponseAsync(response);
        assert.strictEqual(hash1, hash2);
    });

    test("key_order_does_not_affect_hash", async () => {
        const a = {
            data: [{ model_name: "gpt-4.1", model_info: { a: 1, b: 2 } }],
        };
        const b = {
            data: [{ model_name: "gpt-4.1", model_info: { b: 2, a: 1 } }],
        };

        const hashA = await hashModelInfoResponseAsync(a);
        const hashB = await hashModelInfoResponseAsync(b);
        assert.strictEqual(hashA, hashB);
    });

    test("array_order_does_not_affect_hash_when_sorted_by_model_name", async () => {
        const a = {
            data: [
                { model_name: "b", model_info: { supports_reasoning: false } },
                { model_name: "a", model_info: { supports_reasoning: true } },
            ],
        };
        const b = {
            data: [
                { model_name: "a", model_info: { supports_reasoning: true } },
                { model_name: "b", model_info: { supports_reasoning: false } },
            ],
        };

        const hashA = await hashModelInfoResponseAsync(a);
        const hashB = await hashModelInfoResponseAsync(b);
        assert.strictEqual(hashA, hashB);
    });

    test("missing_optional_fields_are_stable", async () => {
        const a = { data: [{ model_name: "gpt-4.1" }] };
        const b = { data: [{ model_name: "gpt-4.1", model_info: undefined }] };

        const hashA = await hashModelInfoResponseAsync(a);
        const hashB = await hashModelInfoResponseAsync(b);
        assert.strictEqual(hashA, hashB);
    });

    test("differing_model_info_fields_produce_different_hash", async () => {
        const a = {
            data: [{ model_name: "gpt-4.1", model_info: { input_cost_per_token: 0.00001 } }],
        };
        const b = {
            data: [{ model_name: "gpt-4.1", model_info: { input_cost_per_token: 0.00002 } }],
        };

        const hashA = await hashModelInfoResponseAsync(a);
        const hashB = await hashModelInfoResponseAsync(b);
        assert.notStrictEqual(hashA, hashB);
    });

    test("canonicalizeModelInfoResponse_returns_deterministic_json", () => {
        const canonical = canonicalizeModelInfoResponse({
            data: [{ model_name: "gpt-4.1", model_info: { z: 1, a: 2 } }],
        });

        assert.strictEqual(canonical, JSON.stringify([{ model_info: { a: 2, z: 1 }, model_name: "gpt-4.1" }]));
    });
});
