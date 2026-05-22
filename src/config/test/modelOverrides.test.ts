import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import {
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

    const buildWorkspaceConfiguration = (overrides: unknown): vscode.WorkspaceConfiguration => {
        const getStub = sinon.stub();
        getStub.callsFake((key: string, defaultValue?: unknown) => {
            if (key === "litellm-connector.modelOverrides") {
                return overrides;
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

    test("loadBundledOverrides returns canonical entries", async () => {
        const overrides = await loadBundledOverrides();

        assert.ok(overrides.length > 0, "should return at least the seed overrides");

        const gptOverride = overrides.find((entry) => entry.match.includes("gpt"));
        const claudeOverride = overrides.find((entry) => entry.match.startsWith("^claude"));
        const catchAllIndex = overrides.findIndex((entry) => entry.match === ".*");
        const catchAll = overrides[catchAllIndex];

        assert.ok(gptOverride, "gpt-5 override should be present");
        assert.deepStrictEqual(gptOverride?.reasoningEfforts, ["none", "low", "medium", "high"]);
        assert.strictEqual(gptOverride?.defaultEffort, "medium");

        assert.ok(claudeOverride, "claude override should be present");
        assert.deepStrictEqual(claudeOverride?.reasoningEfforts, ["none", "low", "medium", "high"]);
        assert.strictEqual(claudeOverride?.defaultEffort, "medium");

        assert.ok(catchAll, "catch-all override should be present");
        assert.strictEqual(catchAllIndex, overrides.length - 1, "catch-all should be last");
        assert.deepStrictEqual(catchAll.reasoningEfforts, CANONICAL_REASONING_EFFORTS);
        assert.strictEqual(catchAll.defaultEffort, "medium");
        assert.strictEqual(catchAll.supportsReasoning, null);
    });

    test("user overrides merge before bundled overrides and take precedence", async () => {
        const userOverrides: ModelOverride[] = [
            {
                match: "^[Gg][Pp][Tt].*",
                supportsReasoning: true,
                reasoningEfforts: ["none", "low"],
                defaultEffort: "none",
            },
        ];

        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        const override = await findOverride("gpt-5-mini");

        assert.ok(override, "user override should be matched first");
        assert.strictEqual(override?.defaultEffort, "none");
        assert.deepStrictEqual(override?.reasoningEfforts, ["none", "low"]);
    });

    test("invalid user override is skipped with a warning and does not crash", async () => {
        const userOverrides: unknown[] = [
            { match: "(", supportsReasoning: true },
            {
                match: ".*",
                supportsReasoning: true,
                reasoningEfforts: ["none", "low"],
                defaultEffort: "low",
            },
        ];

        getConfigurationStub.returns(buildWorkspaceConfiguration(userOverrides));

        const overrides = await loadUserOverrides();

        assert.ok(loggerWarnStub.calledOnce, "invalid regex should trigger a warning");
        assert.strictEqual(overrides.length, 1);
        assert.strictEqual(overrides[0].defaultEffort, "low");
    });

    test("empty config returns default behavior (gpt-5 specific)", async () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));

        // With empty config and no model info for a generic model, returns empty
        // because there's no reason to assume reasoning capability
        const efforts = await getEffectiveEfforts("generic-model");

        assert.deepStrictEqual(efforts, []);

        // For canonical GPT-5 models, when no model info is provided but the model
        // is in the bundled/default list, returns canonical efforts
        const gpt5Efforts = await getEffectiveEfforts("gpt-5-mini");

        assert.deepStrictEqual(gpt5Efforts, ["none", "low", "medium", "high"]);
    });

    test("getEffectiveEfforts inherits proxy support when override is neutral", async () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));
        const supportedInfo: LiteLLMModelInfo = { supports_reasoning: true };
        const unsupportedInfo: LiteLLMModelInfo = { supports_reasoning: false };

        const supported = await getEffectiveEfforts("unknown-model", supportedInfo);
        const unsupported = await getEffectiveEfforts("unknown-model", unsupportedInfo);

        assert.deepStrictEqual(supported, CANONICAL_REASONING_EFFORTS);
        assert.deepStrictEqual(unsupported, []);
    });

    test("getDefaultEffort uses override default then canonical fallback", async () => {
        getConfigurationStub.returns(buildWorkspaceConfiguration([]));

        const gptDefault = await getDefaultEffort("gpt-5-mini");
        const fallbackDefault = await getDefaultEffort("unknown-model", { supports_reasoning: true });
        const unsupportedDefault = await getDefaultEffort("unknown-model", { supports_reasoning: false });

        assert.strictEqual(gptDefault, "medium");
        assert.strictEqual(fallbackDefault, "medium");
        assert.strictEqual(unsupportedDefault, undefined);
    });

    test("forceMandatory override returns values even when LiteLLM has data", async () => {
        const override: ModelOverride = {
            match: "^test-.*",
            reasoningEfforts: ["high"],
            forceMandatory: true,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: false,
        };

        const result = await getEffectiveEfforts("test-model", modelInfo, undefined, true);
        assert.ok(result.includes("high"));
        assert.strictEqual(result.length, 1);
    });

    test("non-mandatory override is ignored when LiteLLM has valid data", async () => {
        const override: ModelOverride = {
            match: "^test-.*",
            reasoningEfforts: ["high"],
            forceMandatory: false,
        };
        getConfigurationStub.returns(buildWorkspaceConfiguration([override]));

        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
        };

        const result = await getEffectiveEfforts("test-model", modelInfo);
        // If LiteLLM has valid data, returns enumeration. When supports_reasoning is true
        // but no effort flags are set, falls back to DEFAULT_REASONING_EFFORTS.
        assert.deepStrictEqual(result, ["none", "low", "medium", "high"]);
    });
});
