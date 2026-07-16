import * as assert from "assert";
import {
    capabilitiesToVSCode,
    getModelTags,
    formatModelDisplayLabel,
    getSupportedReasoningEfforts,
    getDefaultReasoningEffort,
    buildReasoningEffortConfigurationSchema,
    derivePickerCategory,
    type DerivedModelCapabilities,
    type ExtendedModelInformation,
} from "../modelCapabilities";
import type { LiteLLMModelInfo, ModelCapabilityOverride, SupportedReasoningEffort } from "../../types";

suite("modelCapabilities", () => {
    suite("capabilitiesToVSCode", () => {
        test("returns derived capabilities when no overrides", () => {
            const derived = {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: true,
                supportsReasoning: false,
                supportsPdf: false,
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
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
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
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
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
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
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
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
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
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
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
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
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
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
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
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
            const tags = getModelTags("test", {
                supportsTools: false,
                supportsVision: false,
                supportsStreaming: false,
                supportsReasoning: true,
                supportsPdf: true,
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
                endpointMode: "chat" as const,
                maxInputTokens: 100,
                maxOutputTokens: 100,
                rawContextWindow: 200,
            });
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
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
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
                supportsAudioInput: false,
                supportsAudioOutput: false,
                supportsComputerUse: false,
                supportsFunctionCalling: false,
                supportsToolChoice: false,
                supportsSystemMessages: false,
                supportsResponseSchema: false,
                supportsPromptCaching: false,
                supportsWebSearch: false,
                supportsUrlContext: false,
                supportsReasoningEffort: false,
                supportsThinking: false,
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
        test("returns empty array when supports_reasoning is true but reasoning_effort not in supported_openai_params", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supported_openai_params: ["temperature", "stream", "tools"],
            };

            const result = getSupportedReasoningEfforts(modelInfo, "test-model");

            assert.deepStrictEqual(result, []);
        });

        test("returns effort array when reasoning_effort is in supported_openai_params", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supported_openai_params: ["temperature", "reasoning_effort", "stream"],
            };

            const result = getSupportedReasoningEfforts(modelInfo, "test-model");

            assert.ok(result.length > 0, "should have at least one effort");
            assert.ok(result.includes("medium"), "should include medium");
        });

        test("returns effort array when explicit effort fields are present even without reasoning_effort in params", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supports_high_reasoning_effort: true,
                supported_openai_params: ["temperature", "stream"],
            };

            const result = getSupportedReasoningEfforts(modelInfo, "test-model");

            assert.ok(result.length > 0, "should have efforts from explicit fields");
            assert.ok(result.includes("high"), "should include high");
        });

        test("recognizes all expanded explicit reasoning effort fields", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supports_none_reasoning_effort: true,
                supports_minimal_reasoning_effort: true,
                supports_low_reasoning_effort: true,
                supports_medium_reasoning_effort: true,
                supports_high_reasoning_effort: true,
                supports_xhigh_reasoning_effort: true,
                supports_max_reasoning_effort: true,
                supported_openai_params: ["reasoning_effort"],
            };

            assert.deepStrictEqual(getSupportedReasoningEfforts(modelInfo, "test-model"), [
                "none",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
            ]);
        });

        test("keeps only explicit efforts when LiteLLM reports a partial set", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supports_none_reasoning_effort: true,
                supports_minimal_reasoning_effort: null,
                supports_low_reasoning_effort: null,
                supports_medium_reasoning_effort: null,
                supports_high_reasoning_effort: null,
                supports_xhigh_reasoning_effort: true,
                supports_max_reasoning_effort: null,
                supported_openai_params: ["reasoning_effort"],
            };

            assert.deepStrictEqual(getSupportedReasoningEfforts(modelInfo, "luna-model"), ["none", "xhigh"]);
        });

        test("returns the generic fallback ladder when no explicit fields are present", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
            };

            const result = getSupportedReasoningEfforts(modelInfo, "test-model");

            assert.deepStrictEqual(result, ["none", "low", "medium", "high"]);
        });

        test("does not merge an explicitly supported extension with the generic fallback", () => {
            const modelInfo: LiteLLMModelInfo = {
                id: "test-model",
                supports_reasoning: true,
                supports_xhigh_reasoning_effort: true,
                supported_openai_params: ["reasoning_effort"],
            };

            const result = getSupportedReasoningEfforts(modelInfo, "test-model");

            assert.deepStrictEqual(result, ["xhigh"]);
        });

        test("recognizes supports_none_reasoning_effort without broadening the result", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_none_reasoning_effort: true,
                supported_openai_params: ["reasoning_effort"],
            };

            assert.deepStrictEqual(getSupportedReasoningEfforts(modelInfo, "test-model"), ["none"]);
        });

        test("returns empty array for undefined modelInfo", () => {
            const result = getSupportedReasoningEfforts(undefined, "unknown-model");
            assert.deepStrictEqual(result, []);
        });

        test("returns empty array when reasoning support is disabled even for catch-all ids", () => {
            test("returns empty array when model has supports_reasoning=true but no reasoning_effort parameter specified in supported_openai_params", () => {
                const modelInfo: LiteLLMModelInfo = {
                    id: "minimax-large",
                    name: "MiniMax Large",
                    supports_reasoning: true,
                    supports_openai_params: ["temperature", "top_p", "stream"],
                };

                const result = getSupportedReasoningEfforts(modelInfo, "minimax-large");

                // Model supports reasoning capability but does not explicitly support the reasoning_effort parameter
                // Therefore it should get an empty array instead of defaulting to all efforts
                assert.deepStrictEqual(result, []);
            });

            test("returns empty array when reasoning support is disabled even for catch-all ids", () => {
                const modelInfo: LiteLLMModelInfo = {
                    id: "gpt-5-mini",
                    name: "GPT-5 Mini",
                    supports_reasoning: false,
                };

                const result = getSupportedReasoningEfforts(modelInfo, "gpt-5-mini");

                assert.deepStrictEqual(result, []);
            });
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
            const schema = buildReasoningEffortConfigurationSchema(["none", "low", "medium", "high"]);
            const descs = schema?.properties.reasoningEffort.enumDescriptions;
            assert.ok(Array.isArray(descs), "Expected enumDescriptions to be an array");
            assert.strictEqual(descs?.length, 4, "Expected one description per enum value");
            assert.strictEqual(descs?.[0], "No reasoning applied");
            assert.strictEqual(descs?.[1], "Faster responses with less reasoning");
            assert.strictEqual(descs?.[2], "Balanced reasoning and speed");
            assert.strictEqual(descs?.[3], "Greater reasoning depth but slower");
        });

        test("defaults to medium for canonical reasoning configuration", () => {
            const canonicalEfforts: SupportedReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];

            const defaultEffort = getDefaultReasoningEffort(canonicalEfforts, "any-other-model");
            const schema = buildReasoningEffortConfigurationSchema(canonicalEfforts, "any-other-model");

            assert.strictEqual(defaultEffort, "medium");
            // `default` is present so VS Code renders the effort label next to the model name
            // (e.g. "model-name · Medium") before the user makes an explicit selection.
            assert.strictEqual(schema?.properties.reasoningEffort.default, "medium");
        });

        test("defaults to medium for Claude reasoning configuration", () => {
            const claudeEfforts: SupportedReasoningEffort[] = ["none", "low", "medium", "high"];

            const defaultEffort = getDefaultReasoningEffort(claudeEfforts, "claude-haiku-4-5");
            const schema = buildReasoningEffortConfigurationSchema(claudeEfforts, "claude-haiku-4-5");

            assert.strictEqual(defaultEffort, "medium");
            assert.strictEqual(schema?.properties.reasoningEffort.default, "medium");
        });
    });

    suite("derivePickerCategory", () => {
        const baseDerived: DerivedModelCapabilities = {
            supportsTools: false,
            supportsVision: false,
            supportsStreaming: true,
            supportsReasoning: false,
            supportsPdf: false,
            supportsAudioInput: false,
            supportsAudioOutput: false,
            supportsComputerUse: false,
            supportsFunctionCalling: false,
            supportsToolChoice: false,
            supportsSystemMessages: false,
            supportsResponseSchema: false,
            supportsPromptCaching: false,
            supportsWebSearch: false,
            supportsUrlContext: false,
            supportsReasoningEffort: false,
            supportsThinking: false,
            endpointMode: "chat",
            maxInputTokens: 100,
            maxOutputTokens: 50,
            rawContextWindow: 150,
        };

        test("returns 'versatile' for a balanced model (tools + vision, no reasoning, mid context)", () => {
            assert.strictEqual(
                derivePickerCategory({
                    ...baseDerived,
                    supportsTools: true,
                    supportsVision: true,
                    rawContextWindow: 128000,
                }),
                "versatile"
            );
        });

        test("returns 'powerful' when reasoning is supported", () => {
            assert.strictEqual(derivePickerCategory({ ...baseDerived, supportsReasoning: true }), "powerful");
        });

        test("returns 'powerful' when the model advertises a large context window (>= 200k tokens)", () => {
            assert.strictEqual(derivePickerCategory({ ...baseDerived, rawContextWindow: 200000 }), "powerful");
        });

        test("returns 'lightweight' when no tools/vision/reasoning and small context window", () => {
            assert.strictEqual(derivePickerCategory({ ...baseDerived, rawContextWindow: 8000 }), "lightweight");
        });

        test("returns undefined when no signals are present (mid-range context, no tools, no vision, no reasoning)", () => {
            // Important: returning undefined means the picker omits the tag rather
            // than crashing. We must NEVER return null or any non-string value.
            // rawContextWindow is set to 64000 (between the 'lightweight' <= 32000
            // and 'powerful' >= 200000 thresholds) so this is the only "no signal"
            // branch the helper can hit.
            assert.strictEqual(derivePickerCategory({ ...baseDerived, rawContextWindow: 64000 }), undefined);
        });

        test("returns a string literal — never null or an object (regression guard for VS Code picker crash)", () => {
            const result = derivePickerCategory(baseDerived);
            // Guard against the exact bug class: a non-string value reaching the
            // picker's getCategoryLabel switch default branch.
            assert.ok(
                result === undefined || typeof result === "string",
                `expected string | undefined, got ${typeof result}`
            );
        });
    });
});
