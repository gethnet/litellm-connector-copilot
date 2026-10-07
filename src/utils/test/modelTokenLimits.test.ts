import * as assert from "assert";
import { deriveCapabilitiesFromModelInfo } from "../modelCapabilities";
import type { LiteLLMModelInfo } from "../../types";

suite("LiteLLM raw token limit projection (#159)", () => {
    const cases: readonly {
        name: string;
        info?: LiteLLMModelInfo;
        expected: readonly [number, number, number];
    }[] = [
        {
            name: "reported independent limits",
            info: { max_input_tokens: 229376, max_output_tokens: 32768 },
            expected: [229376, 32768, 229376],
        },
        {
            name: "authoritative context",
            info: {
                max_input_tokens: 229376,
                max_output_tokens: 32768,
                context_window_tokens: 262144,
                max_tokens: 999999,
            },
            expected: [229376, 32768, 262144],
        },
        {
            name: "maxima need not sum",
            info: { max_input_tokens: 200000, max_output_tokens: 100000, context_window_tokens: 220000 },
            expected: [200000, 100000, 220000],
        },
        {
            name: "explicit input before ambiguous legacy field",
            info: { max_input_tokens: 229376, max_output_tokens: 32768, max_tokens: 262144 },
            expected: [229376, 32768, 229376],
        },
        {
            name: "normal Claude legacy output field",
            info: { max_input_tokens: 200000, max_output_tokens: 8192, max_tokens: 8192 },
            expected: [200000, 8192, 200000],
        },
        {
            name: "context-only card",
            info: { context_window_tokens: 8192, max_output_tokens: 4096 },
            expected: [8192, 4096, 8192],
        },
        { name: "legacy-only card", info: { max_tokens: 8192 }, expected: [8192, 16000, 8192] },
        { name: "output-only card", info: { max_output_tokens: 2048 }, expected: [128000, 2048, 128000] },
        { name: "absent card", expected: [128000, 16000, 128000] },
        {
            name: "explicit zero is not absence",
            info: { max_input_tokens: 0, max_output_tokens: 0, context_window_tokens: 0 },
            expected: [0, 0, 0],
        },
    ];

    for (const { name, info, expected } of cases) {
        test(name, () => {
            const original = info ? { ...info } : undefined;
            if (info) {
                Object.freeze(info);
            }
            const caps = deriveCapabilitiesFromModelInfo("test-model", info);
            assert.deepStrictEqual([caps.maxInputTokens, caps.maxOutputTokens, caps.rawContextWindow], expected);
            assert.deepStrictEqual(info, original);
        });
    }
});
