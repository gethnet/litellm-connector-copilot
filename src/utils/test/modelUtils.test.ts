import * as assert from "assert";
import * as sinon from "sinon";
import { getModelTags } from "../modelCapabilities";
import type { DerivedModelCapabilities } from "../modelCapabilities";
import type { ModelCapabilityOverride } from "../../types";
import type { LiteLLMModelInfo } from "../../types";

suite("Model Tags Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    function createDerived(overrides: Partial<DerivedModelCapabilities> = {}): DerivedModelCapabilities {
        return {
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
            maxInputTokens: 4096,
            maxOutputTokens: 2048,
            rawContextWindow: 8192,
            ...overrides,
        };
    }

    test("getModelTags adds inline-completions for chat models with streaming", () => {
        const derived = createDerived({ supportsStreaming: true });
        const tags = getModelTags("gpt-4", derived);

        assert.ok(tags.includes("inline-completions"));
        assert.ok(tags.includes("terminal-chat"));
    });

    test("getModelTags adds inline-edit for coder models", () => {
        const derived = createDerived({ supportsStreaming: true });
        const tags = getModelTags("claude-coder", derived);

        assert.ok(tags.includes("inline-edit"));
    });

    test("getModelTags adds tools tag for function-calling models", () => {
        const derived = createDerived({ supportsTools: true });
        const tags = getModelTags("gpt-4", derived);

        assert.ok(tags.includes("tools"));
    });

    test("getModelTags adds vision tag for vision-capable models", () => {
        const derived = createDerived({ supportsVision: true });
        const tags = getModelTags("gpt-4-vision", derived);

        assert.ok(tags.includes("vision"));
    });

    test("getModelTags applies user overrides", () => {
        const derived = createDerived({ supportsStreaming: true });
        const overrides = {
            "gpt-4": ["scm-generator", "inline-edit", "custom-tag"],
        };

        const tags = getModelTags("gpt-4", derived, overrides);

        assert.ok(tags.includes("scm-generator"));
        assert.ok(tags.includes("inline-edit"));
        assert.ok(tags.includes("custom-tag"));
    });

    test("getModelTags returns empty for non-streaming models", () => {
        const derived = createDerived({ supportsStreaming: false });
        const tags = getModelTags("gpt-4", derived);

        assert.strictEqual(tags.length, 0);
    });

    test("getModelTags handles models with no info", () => {
        const derived = createDerived();
        const tags = getModelTags("unknown-model", derived);

        assert.strictEqual(tags.length, 0);
    });

    test("getModelTags combines defaults with overrides", () => {
        const derived = createDerived({
            supportsStreaming: true,
            supportsTools: true,
        });
        const overrides = {
            "coder-model": ["scm-generator"],
        };

        const tags = getModelTags("coder-model", derived, overrides);

        assert.ok(tags.includes("inline-edit"));
        assert.ok(tags.includes("tools"));
        assert.ok(tags.includes("inline-completions"));
        assert.ok(tags.includes("scm-generator"));
    });

    test("getModelTags adds vision tag for vision-capable models", () => {
        const derived = createDerived({ supportsVision: true });
        const tags = getModelTags("gpt-4-vision", derived);

        assert.ok(tags.includes("vision"));
    });

    test("getModelTags adds reasoning tag for reasoning-capable models", () => {
        const derived = createDerived({ supportsReasoning: true });
        const tags = getModelTags("o1-preview", derived);

        assert.ok(tags.includes("reasoning"));
    });

    test("getModelTags adds pdf tag for pdf-capable models", () => {
        const derived = createDerived({ supportsPdf: true });
        const tags = getModelTags("gpt-4", derived);

        assert.ok(tags.includes("pdf"));
    });

    test("getModelTags applies capability overrides", () => {
        const derived = createDerived({ supportsTools: false, supportsVision: false });
        const capabilityOverrides: ModelCapabilityOverride = {
            toolCalling: true,
            imageInput: true,
        };

        const tags = getModelTags("gpt-4", derived, undefined, capabilityOverrides);

        assert.ok(tags.includes("tools"));
        assert.ok(tags.includes("vision"));
    });
});
