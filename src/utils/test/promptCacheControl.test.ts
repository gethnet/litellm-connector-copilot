import * as assert from "assert";
import type { LiteLLMModelInfo, OpenAIChatMessage, OpenAIChatMessageContentItem } from "../../types";
import {
    applyEphemeralCacheControl,
    applyPromptCachePolicy,
    countCacheBreakpoints,
    modelSupportsPromptCacheControl,
} from "../promptCacheControl";

suite("Prompt cache control policy", () => {
    const eligibleModel: LiteLLMModelInfo = {
        supported_openai_params: ["stream", "cache_control"],
    };

    test("enables top-level Path 1 only for cards that advertise cache_control", () => {
        const messages: OpenAIChatMessage[] = [{ role: "user", content: "keep this prefix" }];

        const summary = applyPromptCachePolicy(messages, eligibleModel);

        assert.strictEqual(modelSupportsPromptCacheControl(eligibleModel), true);
        assert.deepStrictEqual(summary, { supported: true, path1: true, explicitCount: 0 });
        assert.ok(!JSON.stringify(messages).includes("cache_control"));
    });

    test("does not enable Path 1 from supports_prompt_caching alone", () => {
        const messages: OpenAIChatMessage[] = [{ role: "user", content: "do not stamp" }];
        const bedrockShapedModel: LiteLLMModelInfo = { supports_prompt_caching: true };

        const summary = applyPromptCachePolicy(messages, bedrockShapedModel);

        assert.strictEqual(modelSupportsPromptCacheControl(bedrockShapedModel), false);
        assert.deepStrictEqual(summary, { supported: false, path1: false, explicitCount: 0 });
        assert.ok(!JSON.stringify(messages).includes("cache_control"));
    });

    test("stamps the last eligible content block only for an explicit host marker", () => {
        const content: OpenAIChatMessageContentItem[] = [
            { type: "text" as const, text: "first block" },
            { type: "image_url" as const, image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
            { type: "text" as const, text: "last block" },
        ];

        const applied = applyEphemeralCacheControl(content);

        assert.strictEqual(applied, true);
        assert.strictEqual(content[0].cache_control, undefined);
        assert.strictEqual(content[1].cache_control, undefined);
        assert.deepStrictEqual(content[2].cache_control, { type: "ephemeral" });
    });

    test("keeps four explicit block stamps but omits Path 1", () => {
        const messages: OpenAIChatMessage[] = Array.from({ length: 5 }, (_, index) => ({
            role: "user",
            content: [{ type: "text", text: `message ${index}`, cache_control: { type: "ephemeral" } }],
        }));

        const summary = applyPromptCachePolicy(messages, eligibleModel);

        assert.deepStrictEqual(summary, { supported: true, path1: false, explicitCount: 4 });
        assert.strictEqual(countCacheBreakpoints(messages), 4);
        assert.deepStrictEqual(
            messages.map((message) => (Array.isArray(message.content) ? message.content[0].cache_control : undefined)),
            [{ type: "ephemeral" }, { type: "ephemeral" }, { type: "ephemeral" }, { type: "ephemeral" }, undefined]
        );
    });

    test("removes explicit stamps from ineligible cards", () => {
        const messages: OpenAIChatMessage[] = [
            {
                role: "user",
                content: [{ type: "text", text: "not eligible", cache_control: { type: "ephemeral" } }],
            },
        ];

        const summary = applyPromptCachePolicy(messages, { supported_openai_params: ["stream"] });

        assert.deepStrictEqual(summary, { supported: false, path1: false, explicitCount: 0 });
        assert.strictEqual(countCacheBreakpoints(messages), 0);
    });
});
