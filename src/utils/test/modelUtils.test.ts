import * as assert from "assert";
import * as sinon from "sinon";
import { getModelTags } from "../modelCapabilities";
import { isFable51Family } from "../modelUtils";
import type { DerivedModelCapabilities } from "../modelCapabilities";
import type { ModelCapabilityOverride } from "../../types";

suite("Fable 5.1 Family Detection", () => {
    /**
     * Matrix of LiteLLM model-ID shapes that must all be recognized as the
     * Fable 5.1 / Mythos 5.1 family. Every guard (tool_choice downgrade,
     * sampling-param denylist) must agree on exactly this set — see the
     * parity suite in parameterValidation.test.ts.
     */
    const matches: readonly string[] = [
        "claude-fable-5-1",
        "claude-mythos-5-1",
        "anthropic/claude-fable-5-1",
        "bedrock/claude-fable-5-1",
        "openrouter/anthropic/claude-fable-5-1",
        "anthropic/claude-mythos-5-1",
        "claude-fable-5-1-20260801", // date-suffixed snapshot
        "claude-fable-5-1@20260801", // @-versioned snapshot (Anthropic/Vertex style)
        "anthropic.claude-fable-5-1-v1:0", // Bedrock dot-namespaced
        "us.anthropic.claude-fable-5-1-v1:0", // Bedrock regional
        "anthropic.claude-mythos-5-1-v1:0",
        // Deliberate conservative over-match: the separator between 5 and 1 is
        // optional, so a stripped-separator lookalike is treated as family.
        // Over-matching costs only a soft downgrade (tool_choice "auto" +
        // stripped sampling params); under-matching a real alias would send a
        // forced tool_choice the backend rejects with a hard 400.
        "claude-fable-51",
    ];

    /**
     * IDs that must NOT match: adjacent-family versions, future minors,
     * and substring-embedded lookalikes.
     */
    const nonMatches: readonly string[] = [
        "claude-fable-5", // base Fable 5 — forced tool_choice still allowed
        "claude-mythos-5", // base Mythos 5
        "claude-fable-5-10", // hypothetical future minor — must not over-match
        "notclaude-fable-5-1", // embedded substring, not a boundary
        "gpt-5.4",
        "claude-opus-4-8",
    ];

    test("matches every aliased/snapshot Fable 5.1 and Mythos 5.1 id shape", () => {
        for (const id of matches) {
            assert.strictEqual(
                isFable51Family(id),
                true,
                `expected family match for "${id}" — aliased/snapshot Fable 5.1 IDs must be recognized so the tool_choice downgrade fires`
            );
        }
    });

    test("rejects adjacent families, future minors, and embedded substrings", () => {
        for (const id of nonMatches) {
            assert.strictEqual(
                isFable51Family(id),
                false,
                `expected NO family match for "${id}" — only the 5.1 generation is affected`
            );
        }
    });
});

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
