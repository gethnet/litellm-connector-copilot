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

    test("preserves partial explicit LiteLLM efforts without inferring siblings", () => {
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

        assert.deepStrictEqual(getEffectiveEfforts("luna-model", modelInfo), ["none", "xhigh"]);
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
        assert.deepStrictEqual(result, ["high"]);
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
});
