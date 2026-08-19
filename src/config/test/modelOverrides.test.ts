import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import {
    applyModelInfoOverrides,
    findOverride,
    getDefaultEffort,
    getEffectiveEfforts,
    loadBundledOverrides,
    loadUserOverrides,
    type ModelOverride,
} from "../modelOverrides";
import type { LiteLLMModelInfo } from "../../types";
import { deriveCapabilitiesFromModelInfo } from "../../utils/modelCapabilities";
import { Logger } from "../../utils/logger";

const CANONICAL_REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;

suite("modelOverrides", () => {
    let getConfigurationStub: sinon.SinonStub;
    let loggerWarnStub: sinon.SinonStub;

    const buildWorkspaceConfiguration = (overrides: unknown, enableOverrides = true): vscode.WorkspaceConfiguration => {
        const getStub = sinon.stub();
        getStub.callsFake((key: string, defaultValue?: unknown) => {
            if (key === "litellm-connector.modelOverrides") {
                return overrides;
            }
            if (key === "litellm-connector.enableModelOverrides") {
                return enableOverrides;
            }
            return defaultValue;
        });

        return {
            get: getStub,
        } as unknown as vscode.WorkspaceConfiguration;
    };

    setup(() => {
        loggerWarnStub = sinon.stub(Logger, "warn");
        getConfigurationStub = sinon.stub(vscode.workspace, "getConfiguration");
    });

    teardown(() => {
        sinon.restore();
    });

    test("loadBundledOverrides returns empty array", () => {
        const overrides = loadBundledOverrides();

        assert.deepStrictEqual(overrides, [], "should return empty bundled overrides array");
    });

    test("loadBundledOverrides can be called but returns empty", () => {
        const overrides = loadBundledOverrides();

        assert.ok(Array.isArray(overrides), "should return an array");
        assert.strictEqual(overrides.length, 0, "should return empty array since bundled overrides were cleared");
    });

    test("user overrides merge before bundled overrides and take precedence", async () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^[Gg][Pp][Tt].*",
                supports_reasoning: true,
                supports_none_reasoning_effort: true,
                supports_low_reasoning_effort: true,
                defaultEffort: "none",
            },
        ];

        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        const override = findOverride("gpt-5-mini");

        assert.ok(override, "user override should be matched first");
        assert.strictEqual(override?.defaultEffort, "none");
        assert.strictEqual(override?.supports_none_reasoning_effort, true);
    });

    test("invalid user override is skipped with a warning and does not crash", async () => {
        const userOverrides: unknown[] = [
            { match: "(", supports_reasoning: true },
            {
                match: ".*",
                supports_reasoning: true,
                supports_none_reasoning_effort: true,
                supports_low_reasoning_effort: true,
                defaultEffort: "low",
            },
        ];

        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        const overrides = loadUserOverrides();

        assert.ok(loggerWarnStub.calledOnce, "invalid regex should trigger a warning");
        assert.strictEqual(overrides.length, 1);
        assert.strictEqual(overrides[0].defaultEffort, "low");
    });

    test("empty config returns default behavior", () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));

        // With empty config and no model info for a generic model
        const efforts = getEffectiveEfforts("generic-model");

        assert.deepStrictEqual(efforts, []);

        // With empty config and no model info, returns empty efforts for all models
        const gpt5Efforts = getEffectiveEfforts("gpt-5-mini");

        assert.deepStrictEqual(gpt5Efforts, []);
    });

    test("getEffectiveEfforts inherits proxy support when override is neutral", async () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));
        const supportedInfo: LiteLLMModelInfo = { supports_reasoning: true };
        const unsupportedInfo: LiteLLMModelInfo = { supports_reasoning: false };

        const supported = getEffectiveEfforts("unknown-model", supportedInfo);
        const unsupported = getEffectiveEfforts("unknown-model", unsupportedInfo);

        assert.deepStrictEqual(supported, CANONICAL_REASONING_EFFORTS);
        assert.deepStrictEqual(unsupported, []);
    });

    test("preserves partial explicit LiteLLM efforts with baseline defaults", () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));
        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
            supports_none_reasoning_effort: true,
            supports_minimal_reasoning_effort: null,
            supports_low_reasoning_effort: null,
            supports_medium_reasoning_effort: null,
            supports_high_reasoning_effort: null,
            supports_xhigh_reasoning_effort: true,
            supports_max_reasoning_effort: null,
        };

        assert.deepStrictEqual(getEffectiveEfforts("luna-model", modelInfo), [
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
        ]);
    });

    test("removes only the baseline effort explicitly marked false", () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));
        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
            supports_low_reasoning_effort: false,
        };

        assert.deepStrictEqual(getEffectiveEfforts("test-model", modelInfo), ["none", "medium", "high"]);
    });

    test("accepts all supported reasoning effort values in user overrides", () => {
        const userOverride: ModelOverride = {
            match: "^test-model$",
            supports_reasoning: true,
            supports_none_reasoning_effort: true,
            supports_minimal_reasoning_effort: true,
            supports_low_reasoning_effort: true,
            supports_medium_reasoning_effort: true,
            supports_high_reasoning_effort: true,
            supports_xhigh_reasoning_effort: true,
            supports_max_reasoning_effort: true,
            defaultEffort: "max",
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([userOverride]));

        const override = findOverride("test-model");

        assert.ok(override);
        assert.strictEqual(override?.supports_max_reasoning_effort, true);
        assert.strictEqual(override?.defaultEffort, "max");
    });

    test("returns no effective efforts when explicit LiteLLM effort fields are all false", () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));
        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
            supports_none_reasoning_effort: false,
            supports_minimal_reasoning_effort: false,
            supports_low_reasoning_effort: false,
            supports_medium_reasoning_effort: false,
            supports_high_reasoning_effort: false,
            supports_xhigh_reasoning_effort: false,
            supports_max_reasoning_effort: false,
        };

        assert.deepStrictEqual(getEffectiveEfforts("test-model", modelInfo), []);
    });

    test("getDefaultEffort returns undefined when no override and no model info", () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));

        const gptDefault = getDefaultEffort("gpt-5-mini");
        const fallbackDefault = getDefaultEffort("unknown-model", { supports_reasoning: true });
        const unsupportedDefault = getDefaultEffort("unknown-model", { supports_reasoning: false });

        assert.strictEqual(gptDefault, undefined);
        assert.strictEqual(fallbackDefault, "medium");
        assert.strictEqual(unsupportedDefault, undefined);
    });

    test("forceMandatory override returns values even when LiteLLM has data", async () => {
        const override: ModelOverride = {
            match: "^test-.*",
            supports_high_reasoning_effort: true,
            forceMandatory: true,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: false,
        };

        const result = getEffectiveEfforts("test-model", modelInfo, undefined, true);
        assert.ok(result.includes("high"));
        assert.strictEqual(result.length, 1);
    });

    test("non-mandatory override is ignored when LiteLLM has valid data", async () => {
        const override: ModelOverride = {
            match: "^test-.*",
            supports_high_reasoning_effort: true,
            forceMandatory: false,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
        };

        const result = getEffectiveEfforts("test-model", modelInfo);
        // If LiteLLM has valid data, returns enumeration. When supports_reasoning is true
        // but no effort flags are set, falls back to DEFAULT_REASONING_EFFORTS.
        assert.deepStrictEqual(result, ["none", "low", "medium", "high"]);
    });

    test("findOverride returns undefined when enableModelOverrides is false", () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^[Gg][Pp][Tt].*",
                supports_reasoning: true,
                supports_none_reasoning_effort: true,
                supports_low_reasoning_effort: true,
                defaultEffort: "none",
            },
        ];
        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides, false));

        const override = findOverride("gpt-5-mini");

        assert.strictEqual(override, undefined, "should return undefined when overrides are disabled");
    });

    test("findOverride returns the active override only when overrides are enabled", () => {
        const disabledConfig = buildWorkspaceConfiguration([{ match: "gpt-4o", notes: "override" }], false);
        assert.strictEqual(findOverride("gpt-4o", disabledConfig), undefined);

        const enabledConfig = buildWorkspaceConfiguration([{ match: "gpt-4o", notes: "override" }]);
        assert.deepStrictEqual(findOverride("gpt-4o", enabledConfig)?.notes, "override");
    });

    test("getEffectiveEfforts ignores overrides when enableModelOverrides is false", () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^test-.*",
                supports_reasoning: true,
                supports_high_reasoning_effort: true,
                defaultEffort: "high",
                forceMandatory: true,
            },
        ];
        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides, false));

        const modelInfo: LiteLLMModelInfo = { supports_reasoning: true };
        const result = getEffectiveEfforts("test-model", modelInfo, undefined, true);

        // When overrides are disabled, forceMandatory should have no effect.
        // Model has supports_reasoning but no explicit effort flags, so falls back to canonical.
        assert.deepStrictEqual(result, CANONICAL_REASONING_EFFORTS);
    });

    test("getDefaultEffort ignores overrides when enableModelOverrides is false", () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^test-.*",
                supports_reasoning: true,
                defaultEffort: "high",
            },
        ];
        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides, false));

        const result = getDefaultEffort("test-model", { supports_reasoning: true });

        // Override defaultEffort of "high" should be ignored; falls through to model info path.
        // With supports_reasoning: true and no override, returns CANONICAL_DEFAULT_EFFORT ("medium").
        assert.strictEqual(result, "medium");
    });

    test("does not override LiteLLM reasoning fields when model overrides are disabled", () => {
        const override = {
            match: "^gpt-4\\.8$",
            supports_reasoning: true,
            supports_max_reasoning_effort: true,
            defaultEffort: "max",
        } as ModelOverride;

        getConfigurationStub.returns(buildWorkspaceConfiguration([override], false));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: false,
            supports_max_reasoning_effort: false,
        };

        assert.deepStrictEqual(applyModelInfoOverrides("gpt-4.8", modelInfo), modelInfo);
    });

    test("replaces only explicitly overridden reasoning fields", () => {
        const override = {
            match: "^gpt-4\\.8$",
            supports_reasoning: true,
            supports_max_reasoning_effort: true,
        } as ModelOverride;

        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: false,
            supports_max_reasoning_effort: false,
            supports_xhigh_reasoning_effort: null,
            supports_low_reasoning_effort: true,
        };

        const result = applyModelInfoOverrides("gpt-4.8", modelInfo);

        assert.strictEqual(result?.supports_reasoning, true);
        assert.strictEqual(result?.supports_max_reasoning_effort, true);
        assert.strictEqual(result?.supports_xhigh_reasoning_effort, null);
        assert.strictEqual(result?.supports_low_reasoning_effort, true);
    });

    test("adds explicitly overridden fields absent from LiteLLM model data", () => {
        const override = {
            match: "^gpt-4\\.8$",
            supports_max_reasoning_effort: true,
        } as ModelOverride;

        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const result = applyModelInfoOverrides("gpt-4.8", { supports_reasoning: true });

        assert.strictEqual(result?.supports_max_reasoning_effort, true);
        assert.strictEqual(result?.supports_reasoning, true);
        assert.strictEqual(result?.supports_xhigh_reasoning_effort, undefined);
    });

    test("preserves null and does not infer sister reasoning fields", () => {
        const override = {
            match: "^gpt-4\\.8$",
            supports_max_reasoning_effort: true,
        } as ModelOverride;

        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const result = applyModelInfoOverrides("gpt-4.8", {
            supports_reasoning: null,
            supports_xhigh_reasoning_effort: null,
        });

        assert.strictEqual(result?.supports_reasoning, null);
        assert.strictEqual(result?.supports_xhigh_reasoning_effort, null);
        assert.strictEqual(result?.supports_max_reasoning_effort, true);
    });

    test("replaces only explicitly overridden mode and token card fields", () => {
        const override = {
            match: "^grok-4\\.5$",
            mode: "chat",
            max_output_tokens: 128000,
        } as ModelOverride;

        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            mode: "responses",
            max_input_tokens: 500000,
            max_output_tokens: 500000,
            max_tokens: 500000,
            context_window_tokens: 500000,
            supports_function_calling: true,
        };

        const result = applyModelInfoOverrides("grok-4.5", modelInfo);

        assert.strictEqual(result?.mode, "chat");
        assert.strictEqual(result?.max_output_tokens, 128000);
        assert.strictEqual(result?.max_input_tokens, 500000);
        assert.strictEqual(result?.max_tokens, 500000);
        assert.strictEqual(result?.context_window_tokens, 500000);
        assert.strictEqual(result?.supports_function_calling, true);
    });

    test("can override total-window token fields when explicitly set", () => {
        const override = {
            match: "^shared-window-model$",
            max_input_tokens: 200000,
            max_tokens: 200000,
            context_window_tokens: 200000,
            max_output_tokens: 32000,
        } as ModelOverride;

        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const result = applyModelInfoOverrides("shared-window-model", {
            max_input_tokens: 1000,
            max_tokens: 1000,
            context_window_tokens: 1000,
            max_output_tokens: 1000,
        });

        assert.strictEqual(result?.max_input_tokens, 200000);
        assert.strictEqual(result?.max_tokens, 200000);
        assert.strictEqual(result?.context_window_tokens, 200000);
        assert.strictEqual(result?.max_output_tokens, 32000);
    });

    test("does not apply mode or token overrides when enableModelOverrides is false", () => {
        const override = {
            match: "^gpt-5\\.3-codex$",
            mode: "chat",
            max_output_tokens: 64000,
        } as ModelOverride;

        getConfigurationStub.returns(buildWorkspaceConfiguration([override], false));

        const modelInfo: LiteLLMModelInfo = {
            mode: "responses",
            max_input_tokens: 272000,
            max_output_tokens: 128000,
        };

        assert.deepStrictEqual(applyModelInfoOverrides("gpt-5.3-codex", modelInfo), modelInfo);
    });

    test("loads valid mode and positive token override fields from user config", () => {
        const userOverrides: unknown[] = [
            {
                match: "^codex$",
                mode: "chat",
                max_input_tokens: 272000,
                max_output_tokens: 128000,
                max_tokens: 400000,
                context_window_tokens: 400000,
            },
            {
                match: "^bad-mode$",
                mode: "embedding",
                max_output_tokens: 1000,
            },
            {
                match: "^bad-tokens$",
                max_output_tokens: 0,
                max_input_tokens: -5,
            },
        ];

        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        const overrides = loadUserOverrides();

        assert.strictEqual(overrides.length, 3);
        assert.strictEqual(overrides[0].mode, "chat");
        assert.strictEqual(overrides[0].max_input_tokens, 272000);
        assert.strictEqual(overrides[0].max_output_tokens, 128000);
        assert.strictEqual(overrides[0].max_tokens, 400000);
        assert.strictEqual(overrides[0].context_window_tokens, 400000);
        assert.strictEqual(overrides[1].mode, undefined, "invalid mode values are dropped");
        assert.strictEqual(overrides[1].max_output_tokens, 1000);
        assert.strictEqual(overrides[2].max_output_tokens, undefined, "non-positive tokens are dropped");
        assert.strictEqual(overrides[2].max_input_tokens, undefined);
        assert.ok(loggerWarnStub.called, "invalid mode/token values should warn");
    });

    test("mode and token overrides feed derived prompt budget for equal-limit cards", () => {
        const override = {
            match: "^grok-4\\.5$",
            max_output_tokens: 128000,
        } as ModelOverride;
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const upstream: LiteLLMModelInfo = {
            mode: "chat",
            max_input_tokens: 500000,
            max_output_tokens: 500000,
        };

        const patched = applyModelInfoOverrides("grok-4.5", upstream);
        const derived = deriveCapabilitiesFromModelInfo("grok-4.5", patched);

        assert.strictEqual(patched?.max_output_tokens, 128000);
        assert.strictEqual(derived.maxOutputTokens, 128000);
        assert.strictEqual(derived.maxInputTokens, 372000);
        assert.strictEqual(derived.rawContextWindow, 500000);
    });

    test("mode override is visible on cached model info used for endpoint selection", () => {
        const override = {
            match: "^gpt-5\\.3-codex$",
            mode: "chat",
        } as ModelOverride;
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const result = applyModelInfoOverrides("gpt-5.3-codex", {
            mode: "responses",
            max_input_tokens: 272000,
            max_output_tokens: 128000,
        });

        assert.strictEqual(result?.mode, "chat");
    });

    test("supportedOpenaiParams fully replaces supported_openai_params when set", () => {
        const override = {
            match: "^some-model$",
            supportedOpenaiParams: ["temperature", "top_p", "tools", "tool_choice", "stream"],
        } as ModelOverride;
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const result = applyModelInfoOverrides("some-model", {
            supported_openai_params: ["stream", "max_tokens", "frequency_penalty"],
            supports_function_calling: true,
        });

        assert.deepStrictEqual(result?.supported_openai_params, [
            "temperature",
            "top_p",
            "tools",
            "tool_choice",
            "stream",
        ]);
        assert.strictEqual(result?.supports_function_calling, true);
    });

    test("empty supportedOpenaiParams replaces supported_openai_params with an empty list", () => {
        const override = {
            match: "^some-model$",
            supportedOpenaiParams: [],
        } as ModelOverride;
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const result = applyModelInfoOverrides("some-model", {
            supported_openai_params: ["temperature", "stream"],
        });

        assert.deepStrictEqual(result?.supported_openai_params, []);
    });

    test("omitted supportedOpenaiParams leaves LiteLLM supported_openai_params unchanged", () => {
        const override = {
            match: "^some-model$",
            mode: "chat",
        } as ModelOverride;
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const upstream: LiteLLMModelInfo = {
            mode: "responses",
            supported_openai_params: ["temperature", "stream"],
        };
        const result = applyModelInfoOverrides("some-model", upstream);

        assert.strictEqual(result?.mode, "chat");
        assert.deepStrictEqual(result?.supported_openai_params, ["temperature", "stream"]);
    });

    test("does not apply supportedOpenaiParams when enableModelOverrides is false", () => {
        const override = {
            match: "^gpt-5$",
            supportedOpenaiParams: ["temperature", "stream"],
        } as ModelOverride;
        getConfigurationStub.returns(buildWorkspaceConfiguration([override], false));

        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["stream"],
        };

        assert.deepStrictEqual(applyModelInfoOverrides("gpt-5", modelInfo), modelInfo);
    });

    test("supportedOpenaiParams-only override still patches model info", () => {
        const override = {
            match: "^params-only$",
            supportedOpenaiParams: ["temperature", "stream"],
        } as ModelOverride;
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const result = applyModelInfoOverrides("params-only", {
            mode: "chat",
            supported_openai_params: ["stream"],
        });

        assert.deepStrictEqual(result?.supported_openai_params, ["temperature", "stream"]);
        assert.strictEqual(result?.mode, "chat");
    });
});
