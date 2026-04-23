import * as assert from "assert";
import { capabilitiesToVSCode, getModelTags, formatProviderName, formatModelName } from "../modelCapabilities";
import type { ModelCapabilityOverride } from "../../types";

suite("modelCapabilities", () => {
    suite("capabilitiesToVSCode", () => {
        test("returns derived capabilities when no overrides", () => {
            const derived = {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: true,
                supportsReasoning: false,
                supportsPdf: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100000,
                maxOutputTokens: 16000,
                rawContextWindow: 128000,
            };
            const caps = capabilitiesToVSCode(derived);
            assert.strictEqual(caps.toolCalling, false);
            assert.strictEqual(caps.imageInput, false);
        });

        test("override toolCalling to true when derived is false", () => {
            const derived = {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: true,
                supportsReasoning: false,
                supportsPdf: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100000,
                maxOutputTokens: 16000,
                rawContextWindow: 128000,
            };
            const overrides: ModelCapabilityOverride = { toolCalling: true };
            const caps = capabilitiesToVSCode(derived, overrides);
            assert.strictEqual(caps.toolCalling, true);
            assert.strictEqual(caps.imageInput, false);
        });

        test("override imageInput to true when derived is false", () => {
            const derived = {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: true,
                supportsReasoning: false,
                supportsPdf: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100000,
                maxOutputTokens: 16000,
                rawContextWindow: 128000,
            };
            const overrides: ModelCapabilityOverride = { imageInput: true };
            const caps = capabilitiesToVSCode(derived, overrides);
            assert.strictEqual(caps.toolCalling, false);
            assert.strictEqual(caps.imageInput, true);
        });

        test("override toolCalling to false when derived is true", () => {
            const derived = {
                supportsTools: true,
                supportsVision: true,
                supportsStreaming: true,
                supportsReasoning: false,
                supportsPdf: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100000,
                maxOutputTokens: 16000,
                rawContextWindow: 128000,
            };
            const overrides: ModelCapabilityOverride = { toolCalling: false };
            const caps = capabilitiesToVSCode(derived, overrides);
            assert.strictEqual(caps.toolCalling, false);
            assert.strictEqual(caps.imageInput, true);
        });

        test("override both capabilities simultaneously", () => {
            const derived = {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: true,
                supportsReasoning: false,
                supportsPdf: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100000,
                maxOutputTokens: 16000,
                rawContextWindow: 128000,
            };
            const overrides: ModelCapabilityOverride = { toolCalling: true, imageInput: true };
            const caps = capabilitiesToVSCode(derived, overrides);
            assert.strictEqual(caps.toolCalling, true);
            assert.strictEqual(caps.imageInput, true);
        });
    });

    suite("getModelTags with capability overrides", () => {
        test("adds tools tag when toolCalling is overridden to true", () => {
            const derived = {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: true,
                supportsReasoning: false,
                supportsPdf: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100000,
                maxOutputTokens: 16000,
                rawContextWindow: 128000,
            };
            const capabilityOverrides: ModelCapabilityOverride = { toolCalling: true };
            const tags = getModelTags("gpt-4o", derived, {}, capabilityOverrides);
            assert.ok(tags.includes("tools"), "Should include tools tag from capability override");
            assert.ok(!tags.includes("vision"), "Should not include vision tag");
        });

        test("adds vision tag when imageInput is overridden to true", () => {
            const derived = {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: true,
                supportsReasoning: false,
                supportsPdf: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100000,
                maxOutputTokens: 16000,
                rawContextWindow: 128000,
            };
            const capabilityOverrides: ModelCapabilityOverride = { imageInput: true };
            const tags = getModelTags("gpt-4o", derived, {}, capabilityOverrides);
            assert.ok(tags.includes("vision"), "Should include vision tag from capability override");
            assert.ok(!tags.includes("tools"), "Should not include tools tag");
        });

        test("removes tools tag when toolCalling is overridden to false", () => {
            const derived = {
                supportsTools: true,
                supportsVision: true,
                supportsStreaming: true,
                supportsReasoning: false,
                supportsPdf: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100000,
                maxOutputTokens: 16000,
                rawContextWindow: 128000,
            };
            const capabilityOverrides: ModelCapabilityOverride = { toolCalling: false };
            const tags = getModelTags("gpt-4o", derived, {}, capabilityOverrides);
            assert.ok(!tags.includes("tools"), "Should not include tools tag when overridden to false");
            assert.ok(tags.includes("vision"), "Should still include vision tag");
        });

        test("adds reasoning and pdf tags based on capabilities", () => {
            const derived = {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: false,
                supportsReasoning: true,
                supportsPdf: true,
                endpointMode: "chat" as const,
                maxInputTokens: 100,
                maxOutputTokens: 100,
                rawContextWindow: 200,
            };
            const tags = getModelTags("test", derived);
            assert.ok(tags.includes("reasoning"), "should have reasoning tag");
            assert.ok(tags.includes("pdf"), "should have pdf tag");
        });

        test("adds reasoning and pdf tags based on overrides", () => {
            const derived = {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: false,
                supportsReasoning: false,
                supportsPdf: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100,
                maxOutputTokens: 100,
                rawContextWindow: 200,
            };
            const capabilityOverrides: ModelCapabilityOverride = { reasoning: true, pdfInput: true };
            const tags = getModelTags("test", derived, {}, capabilityOverrides);
            assert.ok(tags.includes("reasoning"), "should have reasoning tag from override");
            assert.ok(tags.includes("pdf"), "should have pdf tag from override");
        });

        test("override merges tag overrides and capability overrides together", () => {
            const derived = {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: true,
                supportsReasoning: false,
                supportsPdf: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100000,
                maxOutputTokens: 16000,
                rawContextWindow: 128000,
            };
            const tagOverrides = { "gpt-4o": ["custom-tag"] };
            const capabilityOverrides: ModelCapabilityOverride = { toolCalling: true };
            const tags = getModelTags("gpt-4o", derived, tagOverrides, capabilityOverrides);
            assert.ok(tags.includes("tools"), "Should include tools tag from capability override");
            assert.ok(tags.includes("custom-tag"), "Should include custom tag from tag overrides");
        });
    });

    suite("formatProviderName and formatModelName", () => {
        test("formatProviderName title-cases single-word providers", () => {
            assert.strictEqual(formatProviderName("anthropic"), "Anthropic");
            assert.strictEqual(formatProviderName("google"), "Google");
            assert.strictEqual(formatProviderName("azure"), "Azure");
            assert.strictEqual(formatProviderName("ollama"), "Ollama");
            assert.strictEqual(formatProviderName("groq"), "Groq");
            assert.strictEqual(formatProviderName("mistral"), "Mistral");
            assert.strictEqual(formatProviderName("bedrock"), "Bedrock");
            assert.strictEqual(formatProviderName("perplexity"), "Perplexity");
        });

        test("formatProviderName detects and capitalizes acronym suffixes", () => {
            assert.strictEqual(formatProviderName("openai"), "Open AI"); // Detects "ai" suffix
            assert.strictEqual(formatProviderName("openrouter"), "Openrouter"); // "router" not an acronym
            assert.strictEqual(formatProviderName("xai"), "xAI"); // Single letter + "ai"
        });

        test("formatProviderName handles hyphenated and underscored names", () => {
            assert.strictEqual(formatProviderName("custom-provider"), "Custom Provider");
            assert.strictEqual(formatProviderName("my_provider"), "My Provider");
        });

        test("formatProviderName title-cases unknown single-word providers", () => {
            assert.strictEqual(formatProviderName("customprovider"), "Customprovider");
            assert.strictEqual(formatProviderName("myprovider"), "Myprovider");
        });

        test("formatModelName applies intelligent formatting rules", () => {
            assert.strictEqual(formatModelName("gpt-4o"), "GPT 4o");
            assert.strictEqual(formatModelName("gpt-4o-mini"), "GPT 4o Mini");
            assert.strictEqual(formatModelName("claude-3-5-sonnet-20241022"), "Claude 3 5 Sonnet 20241022");
            assert.strictEqual(formatModelName("gemini-2-5-pro"), "Gemini 2 5 Pro");
            assert.strictEqual(formatModelName("o3-mini"), "O3 Mini");
        });

        test("formatModelName handles general cases with title casing", () => {
            assert.strictEqual(formatModelName("my-custom-model"), "My Custom Model");
            assert.strictEqual(formatModelName("llama-3-70b"), "Llama 3 70b");
        });
    });
});
