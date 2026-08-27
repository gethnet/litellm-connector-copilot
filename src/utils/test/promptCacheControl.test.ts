import * as assert from "assert";
import type { LiteLLMModelInfo, OpenAIChatMessage, OpenAIChatMessageContentItem } from "../../types";
import {
    applyEphemeralCacheControl,
    applyPromptCachePolicy,
    countCacheBreakpoints,
    modelSupportsPromptCacheControl,
} from "../promptCacheControl";

suite("Prompt cache control policy", () => {
    const claudeId = "claude-opus-5";
    const eligibleModel: LiteLLMModelInfo = {
        supported_openai_params: ["stream", "cache_control"],
        litellm_provider: "anthropic",
    };

    test("enables top-level Path 1 only for Anthropic cards that advertise cache_control", () => {
        const messages: OpenAIChatMessage[] = [{ role: "user", content: "keep this prefix" }];

        const summary = applyPromptCachePolicy(messages, claudeId, eligibleModel);

        assert.strictEqual(modelSupportsPromptCacheControl(claudeId, eligibleModel), true);
        assert.deepStrictEqual(summary, { supported: true, path1: true, explicitCount: 0 });
        assert.ok(!JSON.stringify(messages).includes("cache_control"));
    });

    test("keeps Azure-hosted Claude eligible when the card lists cache_control", () => {
        const azureClaude: LiteLLMModelInfo = {
            supported_openai_params: ["cache_control"],
            litellm_provider: "azure_ai",
        };

        assert.strictEqual(modelSupportsPromptCacheControl("azure_ai/claude-haiku-4-5", azureClaude), true);
        assert.deepStrictEqual(
            applyPromptCachePolicy([{ role: "user", content: "prefix" }], "azure_ai/claude-haiku-4-5", azureClaude),
            {
                supported: true,
                path1: true,
                explicitCount: 0,
            }
        );
    });

    test("does not enable Path 1 from supports_prompt_caching alone", () => {
        const messages: OpenAIChatMessage[] = [{ role: "user", content: "do not stamp" }];
        const bedrockShapedModel: LiteLLMModelInfo = { supports_prompt_caching: true };

        const summary = applyPromptCachePolicy(messages, "global.anthropic.claude-opus-4-7", bedrockShapedModel);

        assert.strictEqual(
            modelSupportsPromptCacheControl("global.anthropic.claude-opus-4-7", bedrockShapedModel),
            false
        );
        assert.deepStrictEqual(summary, { supported: false, path1: false, explicitCount: 0 });
        assert.ok(!JSON.stringify(messages).includes("cache_control"));
    });

    test("does not enable Path 1 from prompt_cache_key", () => {
        const openaiCard: LiteLLMModelInfo = {
            supported_openai_params: ["prompt_cache_key", "prompt_cache_retention"],
            supports_prompt_caching: true,
            litellm_provider: "openai",
        };

        assert.strictEqual(modelSupportsPromptCacheControl("gpt-4o-mini", openaiCard), false);
        assert.deepStrictEqual(
            applyPromptCachePolicy([{ role: "user", content: "no stamp" }], "gpt-4o-mini", openaiCard),
            {
                supported: false,
                path1: false,
                explicitCount: 0,
            }
        );
    });

    test("ignores a lying GPT card that advertises cache_control", () => {
        const lyingGptCard: LiteLLMModelInfo = {
            supported_openai_params: ["cache_control", "prompt_cache_key"],
            litellm_provider: "openai",
        };

        assert.strictEqual(modelSupportsPromptCacheControl("azure_ai/us-central/gpt-4o-mini", lyingGptCard), false);
        assert.deepStrictEqual(
            applyPromptCachePolicy(
                [{ role: "user", content: "do not stamp" }],
                "azure_ai/us-central/gpt-4o-mini",
                lyingGptCard
            ),
            { supported: false, path1: false, explicitCount: 0 }
        );
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

    test("stamps cache_control on a trailing PDF file item", () => {
        const content: OpenAIChatMessageContentItem[] = [
            { type: "text" as const, text: "analyze this PDF" },
            {
                type: "file" as const,
                file: {
                    filename: "secret.pdf",
                    file_data: "data:application/pdf;base64,JVBERi0=",
                },
            },
        ];

        const applied = applyEphemeralCacheControl(content);

        assert.strictEqual(applied, true);
        assert.strictEqual(content[0].cache_control, undefined);
        assert.deepStrictEqual(content[1].cache_control, { type: "ephemeral" });
    });

    test("keeps four explicit block stamps but omits Path 1", () => {
        const messages: OpenAIChatMessage[] = Array.from({ length: 5 }, (_, index) => ({
            role: "user",
            content: [{ type: "text", text: `message ${index}`, cache_control: { type: "ephemeral" } }],
        }));

        const summary = applyPromptCachePolicy(messages, claudeId, eligibleModel);

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

        const summary = applyPromptCachePolicy(messages, claudeId, { supported_openai_params: ["stream"] });

        assert.deepStrictEqual(summary, { supported: false, path1: false, explicitCount: 0 });
        assert.strictEqual(countCacheBreakpoints(messages), 0);
    });
});
