import * as assert from "assert";
import type { LiteLLMModelInfo } from "../../types";
import { resolveChatReasoningTransport } from "../base/reasoningTransport";

suite("reasoningTransport", () => {
    const supports = (parameter: string, modelInfo: LiteLLMModelInfo | undefined): boolean =>
        modelInfo?.supported_openai_params?.includes(parameter) === true;

    test("enables adaptive thinking for confirmed Claude families", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["reasoning_effort", "thinking"],
        };

        assert.deepStrictEqual(
            resolveChatReasoningTransport("high", "vertex_ai/claude-opus-4-8", modelInfo, supports),
            {
                reasoning_effort: "high",
                thinking: { type: "adaptive" },
                output_config: { effort: "high" },
            }
        );
        assert.deepStrictEqual(
            resolveChatReasoningTransport("medium", "anthropic/claude-sonnet-5", modelInfo, supports).thinking,
            { type: "adaptive" }
        );
        assert.deepStrictEqual(
            resolveChatReasoningTransport("low", "claude-fable-5-1", modelInfo, supports).output_config,
            { effort: "low" }
        );
    });

    test("requires explicit capability for aliases and leaves Opus 4.7 and Mythos unchanged", () => {
        const explicitInfo: LiteLLMModelInfo = {
            supports_adaptive_thinking: true,
            supported_openai_params: ["reasoning_effort", "thinking"],
        };
        const advertisedOnly: LiteLLMModelInfo = {
            supported_openai_params: ["reasoning_effort", "thinking"],
        };

        assert.deepStrictEqual(
            resolveChatReasoningTransport("high", "my-private-claude-alias", explicitInfo, supports).thinking,
            { type: "adaptive" }
        );
        assert.deepStrictEqual(
            resolveChatReasoningTransport("high", "anthropic/claude-opus-4-7", advertisedOnly, supports),
            { reasoning_effort: "high" }
        );
        assert.deepStrictEqual(resolveChatReasoningTransport("high", "claude-mythos-5", advertisedOnly, supports), {
            reasoning_effort: "high",
        });
    });

    test("does not emit native fields when thinking is unavailable or effort is none", () => {
        assert.deepStrictEqual(
            resolveChatReasoningTransport(
                "high",
                "claude-opus-5",
                { supports_adaptive_thinking: true, supported_openai_params: ["reasoning_effort"] },
                supports
            ),
            { reasoning_effort: "high" }
        );
        assert.deepStrictEqual(
            resolveChatReasoningTransport(
                "none",
                "claude-opus-5",
                { supports_adaptive_thinking: true, supported_openai_params: ["reasoning_effort", "thinking"] },
                supports
            ),
            { reasoning_effort: "none" }
        );
    });

    test("omits reasoning when no effort is selected and keeps GPT on flat transport", () => {
        assert.deepStrictEqual(
            resolveChatReasoningTransport(
                undefined,
                "claude-opus-5",
                { supports_adaptive_thinking: true, supported_openai_params: ["reasoning_effort", "thinking"] },
                supports
            ),
            {}
        );
        assert.deepStrictEqual(
            resolveChatReasoningTransport(
                "high",
                "azure_ai/gpt-5.6",
                { supported_openai_params: ["reasoning_effort"] },
                supports
            ),
            { reasoning_effort: "high" }
        );
    });
});
