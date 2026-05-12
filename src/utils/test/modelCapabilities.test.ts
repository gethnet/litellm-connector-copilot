import * as assert from "assert";
import {
    capabilitiesToVSCode,
    getModelTags,
    formatModelDisplayLabel,
    getSupportedReasoningEfforts,
    buildReasoningEffortConfigurationSchema,
    type ExtendedModelInformation,
} from "../modelCapabilities";
import type { ModelCapabilityOverride } from "../../types";
import type { LiteLLMModelInfo } from "../../types";

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

    suite("formatModelDisplayLabel", () => {
        test("formats strings correctly", () => {
            assert.strictEqual(formatModelDisplayLabel("gpt-4o", "openai"), "[openai] gpt-4o");
            assert.strictEqual(formatModelDisplayLabel("gpt-4o"), "gpt-4o");
            assert.strictEqual(formatModelDisplayLabel("gpt-4o", ""), "gpt-4o");
        });

        test("formats model objects correctly", () => {
            const mockModel = { name: "gpt-4o", vendor: "openai" } as unknown as ExtendedModelInformation;
            assert.strictEqual(formatModelDisplayLabel(mockModel), "[openai] gpt-4o");

            const mockModelNoVendor = { name: "gpt-4o" } as unknown as ExtendedModelInformation;
            assert.strictEqual(formatModelDisplayLabel(mockModelNoVendor), "gpt-4o");
        });
    });

    suite("getSupportedReasoningEfforts", () => {
        test("returns empty array for undefined modelInfo", () => {
            const result = getSupportedReasoningEfforts(undefined);
            assert.deepStrictEqual(result, []);
        });

        test("returns empty array for model with no reasoning fields", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "gpt-4",
                name: "GPT-4",
                supports_vision: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.deepStrictEqual(result, []);
        });

        test("returns none plus minimal effort from supports_minimal_reasoning_effort", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "gpt-4o-mini",
                name: "GPT-4o Mini",
                supports_reasoning: true,
                supports_minimal_reasoning_effort: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.deepStrictEqual(result, ["none", "minimal"]);
        });

        test("returns none plus low effort from supports_low_reasoning_effort", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "gpt-4",
                name: "GPT-4",
                supports_reasoning: true,
                supports_low_reasoning_effort: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.deepStrictEqual(result, ["none", "low"]);
        });

        test("maps supports_xlow_reasoning_effort to low", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "gpt-4-turbo",
                name: "GPT-4 Turbo",
                supports_reasoning: true,
                supports_xlow_reasoning_effort: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.deepStrictEqual(result, ["none", "low"]);
        });

        test("returns none plus high effort from supports_high_reasoning_effort", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "gpt-4o",
                name: "GPT-4o",
                supports_reasoning: true,
                supports_high_reasoning_effort: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.deepStrictEqual(result, ["none", "high"]);
        });

        test("returns none plus xhigh effort from supports_xhigh_reasoning_effort", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "gpt-4-turbo-preview",
                name: "GPT-4 Turbo Preview",
                supports_reasoning: true,
                supports_xhigh_reasoning_effort: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.deepStrictEqual(result, ["none", "xhigh"]);
        });

        test("returns the full OpenAI-aligned effort set for general reasoning support", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "claude-3",
                name: "Claude 3",
                supports_reasoning: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.deepStrictEqual(
                result,
                ["none", "minimal", "low", "medium", "high", "xhigh"] as const,
                "Should return default efforts for general reasoning support"
            );
        });

        test("respects alias support_xlow as low", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "test-model-xlow",
                name: "Test Model XLow",
                supports_reasoning: true,
                supports_xlow_reasoning_effort: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.ok(result.includes("low"), "Should support low effort when supports_xlow_reasoning_effort is true");
            assert.ok(!result.includes("high"), "Should not include high when only xlow is set");
        });

        test("respects alias support_xhigh as xhigh", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "test-model-xhigh",
                name: "Test Model XHigh",
                supports_reasoning: true,
                supports_xhigh_reasoning_effort: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.ok(
                result.includes("xhigh"),
                "Should support xhigh effort when supports_xhigh_reasoning_effort is true"
            );
            assert.ok(!result.includes("low"), "Should not include low when only xhigh is set");
        });

        test("returns every explicitly supported level once", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "multi-level-model",
                name: "Multi-Level Model",
                supports_reasoning: true,
                supports_minimal_reasoning_effort: true,
                supports_low_reasoning_effort: true,
                supports_high_reasoning_effort: true,
                supports_xhigh_reasoning_effort: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.deepStrictEqual(result, ["none", "minimal", "low", "high", "xhigh"]);
        });

        test("ignores generic defaults when specific levels are provided", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "specific-model",
                name: "Specific Model",
                supports_reasoning: true,
                supports_low_reasoning_effort: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo);
            assert.deepStrictEqual(result, ["none", "low"]);
            assert.ok(!result.includes("medium"), "Should not include medium when specific level is set");
            assert.ok(!result.includes("high"), "Should not include high when only low is set");
        });
    });

    suite("buildReasoningEffortConfigurationSchema", () => {
        test("returns undefined when model does not support any reasoning effort", () => {
            const schema = buildReasoningEffortConfigurationSchema([]);
            assert.strictEqual(schema, undefined);
        });

        test("returns schema with navigation group so picker is surfaced inline", () => {
            const schema = buildReasoningEffortConfigurationSchema(["none", "low", "medium", "high"]);
            assert.ok(schema, "Expected schema for non-empty efforts");
            const prop = schema?.properties.reasoningEffort;
            // Without `group: "navigation"` VS Code 1.120 hides the configuration property behind
            // the secondary settings UI and the reasoning effort picker is not visible from the
            // chat model selector. This guards against regressions where the field is dropped.
            assert.strictEqual(prop?.group, "navigation");
            assert.strictEqual(prop?.type, "string");
            assert.deepStrictEqual(prop?.enum, ["none", "low", "medium", "high"]);
        });

        test("uses 'Thinking Effort' as title to match native VS Code model picker section heading", () => {
            const schema = buildReasoningEffortConfigurationSchema(["low", "medium", "high"]);
            // VS Code renders the `title` field as the section heading in the model picker hover popup.
            // Matching the native "Thinking Effort" label keeps the UX consistent with Copilot's own models.
            assert.strictEqual(schema?.properties.reasoningEffort.title, "Thinking Effort");
        });

        test("renders capitalized human-readable labels in enumItemLabels", () => {
            const schema = buildReasoningEffortConfigurationSchema(["none", "low", "medium", "high"]);
            // Capitalization matches OS-native quick-pick formatting; tests pin this so the
            // user-visible labels do not silently regress to lower-case.
            assert.deepStrictEqual(schema?.properties.reasoningEffort.enumItemLabels, [
                "None",
                "Low",
                "Medium",
                "High",
            ]);
        });

        test("includes enumDescriptions for each effort so VS Code renders explanatory text in popup", () => {
            // enumDescriptions is the field VS Code uses to render the per-item description text
            // that appears alongside each option in the model picker hover popup (e.g.
            // "Balanced reasoning and speed" for "medium"). Without this, the picker shows only
            // labels with no guidance — exactly what Copilot's own models provide.
            const schema = buildReasoningEffortConfigurationSchema(["none", "low", "medium", "high", "xhigh"]);
            const descs = schema?.properties.reasoningEffort.enumDescriptions;
            assert.ok(Array.isArray(descs), "Expected enumDescriptions to be an array");
            assert.strictEqual(descs?.length, 5, "Expected one description per enum value");
            assert.strictEqual(descs?.[0], "No reasoning applied");
            assert.strictEqual(descs?.[1], "Faster responses with less reasoning");
            assert.strictEqual(descs?.[2], "Balanced reasoning and speed");
            assert.strictEqual(descs?.[3], "Greater reasoning depth but slower");
            assert.strictEqual(descs?.[4], "Maximum reasoning depth but slower");
        });

        test("default is medium when supported, otherwise first non-none entry", () => {
            const withMedium = buildReasoningEffortConfigurationSchema(["none", "low", "medium", "high"]);
            assert.strictEqual(withMedium?.properties.reasoningEffort.default, "medium");

            const withoutMedium = buildReasoningEffortConfigurationSchema(["none", "low", "high"]);
            assert.strictEqual(withoutMedium?.properties.reasoningEffort.default, "low");
        });
    });
});
