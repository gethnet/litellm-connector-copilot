import * as vscode from "vscode";
import type {
    LiteLLMModelInfo,
    ModelOverride,
    ReasoningModelInfoField,
    ReasoningModelInfoPatch,
    SupportedReasoningEffort,
} from "../types";
import { Logger } from "../utils/logger";
import { getDefaultReasoningEffort } from "../utils/modelCapabilities";
import bundledOverridesSource from "./modelOverrides.json";

const bundledOverridesData: unknown = bundledOverridesSource;

/**
 * Local copy of LiteLLM reasoning effort field mapping.
 * Kept in sync with src/utils/modelCapabilities.ts.
 */
const LITELLM_REASONING_EFFORT_MAPPING: Record<string, SupportedReasoningEffort> = {
    supports_none_reasoning_effort: "none",
    supports_minimal_reasoning_effort: "minimal",
    supports_low_reasoning_effort: "low",
    supports_xlow_reasoning_effort: "low",
    supports_medium_reasoning_effort: "medium",
    supports_high_reasoning_effort: "high",
    supports_xhigh_reasoning_effort: "xhigh",
    supports_max_reasoning_effort: "max",
} as const satisfies Record<string, SupportedReasoningEffort>;

const CANONICAL_REASONING_EFFORTS: readonly SupportedReasoningEffort[] = ["none", "low", "medium", "high"];

const CANONICAL_DEFAULT_EFFORT: SupportedReasoningEffort = "medium";

const MODEL_OVERRIDES_SETTING_KEY = "litellm-connector.modelOverrides";

const REASONING_MODEL_INFO_FIELDS: readonly ReasoningModelInfoField[] = [
    "supports_reasoning",
    "supports_none_reasoning_effort",
    "supports_minimal_reasoning_effort",
    "supports_low_reasoning_effort",
    "supports_medium_reasoning_effort",
    "supports_high_reasoning_effort",
    "supports_xhigh_reasoning_effort",
    "supports_max_reasoning_effort",
];

let bundledOverridesCache: ModelOverride[] | undefined;

function isSupportedReasoningEffort(value: unknown): value is SupportedReasoningEffort {
    return (
        value === "none" ||
        value === "minimal" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh" ||
        value === "max"
    );
}

/**
 * Coerce an unknown value to a `string[]` of trimmed, non-empty entries.
 * Returns `undefined` when the input is not an array or contains no strings.
 *
 * Used to safely validate user-supplied override fields (`tags`,
 * `supportedOpenaiParams`) without tripping `no-unsafe-*` lints. `Array.isArray`
 * on its own narrows `unknown` to `any[]`, which is why the runtime check is
 * paired here with an explicit `unknown[]` filter.
 */
export function toStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const items = (value as unknown[]).filter((v): v is string => typeof v === "string");
    return items.length > 0 ? items : undefined;
}

function validateOverride(entry: unknown, source: string): ModelOverride | undefined {
    if (!entry || typeof entry !== "object") {
        Logger.warn(`[modelOverrides] Skipping invalid override from ${source}: not an object`);
        return undefined;
    }

    const candidate = entry as Partial<ModelOverride>;

    if (!candidate.match || typeof candidate.match !== "string") {
        Logger.warn(`[modelOverrides] Skipping invalid override from ${source}: missing match`);
        return undefined;
    }

    try {
        RegExp(candidate.match);
    } catch {
        Logger.warn(`[modelOverrides] Skipping invalid override regex from ${source}: ${candidate.match}`);
        return undefined;
    }

    const defaultEffort =
        candidate.defaultEffort && isSupportedReasoningEffort(candidate.defaultEffort)
            ? candidate.defaultEffort
            : undefined;

    return {
        match: candidate.match,
        supports_reasoning: candidate.supports_reasoning,
        supports_none_reasoning_effort: candidate.supports_none_reasoning_effort,
        supports_minimal_reasoning_effort: candidate.supports_minimal_reasoning_effort,
        supports_low_reasoning_effort: candidate.supports_low_reasoning_effort,
        supports_medium_reasoning_effort: candidate.supports_medium_reasoning_effort,
        supports_high_reasoning_effort: candidate.supports_high_reasoning_effort,
        supports_xhigh_reasoning_effort: candidate.supports_xhigh_reasoning_effort,
        supports_max_reasoning_effort: candidate.supports_max_reasoning_effort,
        defaultEffort,
        forceMandatory: candidate.forceMandatory === true,
        tags: toStringArray(candidate.tags),
        supportedOpenaiParams: toStringArray(candidate.supportedOpenaiParams),
        notes: candidate.notes,
    };
}

export function loadBundledOverrides(): ModelOverride[] {
    if (bundledOverridesCache) {
        return bundledOverridesCache;
    }

    const validated = (Array.isArray(bundledOverridesData) ? bundledOverridesData : []).map((entry) =>
        validateOverride(entry, "bundled")
    );

    bundledOverridesCache = validated.filter((entry): entry is ModelOverride => Boolean(entry));
    return bundledOverridesCache;
}

export function loadUserOverrides(config?: vscode.WorkspaceConfiguration): ModelOverride[] {
    const workspaceConfig = config ?? vscode.workspace.getConfiguration();
    const raw = workspaceConfig.get<unknown>(MODEL_OVERRIDES_SETTING_KEY, []);

    if (!Array.isArray(raw)) {
        if (raw) {
            Logger.warn(`[modelOverrides] Expected array for ${MODEL_OVERRIDES_SETTING_KEY}; got ${typeof raw}`);
        }
        return [];
    }

    const validated = raw
        .map((entry, index) => validateOverride(entry, `user[${index}]`))
        .filter((entry): entry is ModelOverride => Boolean(entry));

    return validated;
}

export function getMergedOverrides(config?: vscode.WorkspaceConfiguration): ModelOverride[] {
    const user = loadUserOverrides(config);
    const bundled = loadBundledOverrides();
    return [...user, ...bundled];
}

export function findOverride(modelId: string, config?: vscode.WorkspaceConfiguration): ModelOverride | undefined {
    const workspaceConfig = config ?? vscode.workspace.getConfiguration();
    const enableModelOverrides = workspaceConfig.get<boolean>("litellm-connector.enableModelOverrides", false);
    if (!enableModelOverrides) {
        return undefined;
    }

    const overrides = getMergedOverrides(config);

    for (const override of overrides) {
        try {
            const regex = new RegExp(override.match, "i");
            if (regex.test(modelId)) {
                return override;
            }
        } catch {
            Logger.warn(`[modelOverrides] Invalid regex at match time: ${override.match}`);
        }
    }

    return undefined;
}

export function applyModelInfoOverrides(
    modelId: string,
    modelInfo: LiteLLMModelInfo | undefined,
    config?: vscode.WorkspaceConfiguration
): LiteLLMModelInfo | undefined {
    if (!modelInfo) {
        return modelInfo;
    }

    const override = findOverride(modelId, config);
    if (!override) {
        return modelInfo;
    }

    const patch: ReasoningModelInfoPatch = {};
    for (const field of REASONING_MODEL_INFO_FIELDS) {
        const value = override[field];
        if (value !== undefined) {
            patch[field] = value;
        }
    }

    return Object.keys(patch).length > 0 ? { ...modelInfo, ...patch } : modelInfo;
}

function getExplicitReasoningEfforts(modelInfo?: LiteLLMModelInfo): SupportedReasoningEffort[] | undefined {
    if (!modelInfo) {
        return undefined;
    }
    const explicitEfforts: SupportedReasoningEffort[] = [];
    let hasExplicitField = false;
    for (const [key, value] of Object.entries(LITELLM_REASONING_EFFORT_MAPPING)) {
        const fieldValue = modelInfo[key as keyof LiteLLMModelInfo];
        if (fieldValue !== undefined && fieldValue !== null) {
            hasExplicitField = true;
        }
        if (fieldValue === true) {
            explicitEfforts.push(value);
        }
    }
    return hasExplicitField ? explicitEfforts : undefined;
}

export function getEffectiveEfforts(
    modelId: string,
    modelInfo?: LiteLLMModelInfo,
    config?: vscode.WorkspaceConfiguration,
    forceMandatory?: boolean
): readonly SupportedReasoningEffort[] {
    const patchedModelInfo = applyModelInfoOverrides(modelId, modelInfo, config);
    const override = findOverride(modelId, config);
    if (forceMandatory && override?.forceMandatory) {
        return getEffectiveEffortsFromModelInfo({
            ...patchedModelInfo,
            supports_reasoning: true,
        });
    }
    return getEffectiveEffortsFromModelInfo(patchedModelInfo);
}

function getEffectiveEffortsFromModelInfo(modelInfo?: LiteLLMModelInfo): readonly SupportedReasoningEffort[] {
    if (!modelInfo || modelInfo.supports_reasoning === false) {
        return [];
    }

    const explicitEfforts = getExplicitReasoningEfforts(modelInfo);
    if (explicitEfforts !== undefined) {
        return explicitEfforts;
    }

    return modelInfo.supports_reasoning === true ? [...CANONICAL_REASONING_EFFORTS] : [];
}

export function getDefaultEffort(
    modelId: string,
    modelInfo?: LiteLLMModelInfo,
    config?: vscode.WorkspaceConfiguration
): SupportedReasoningEffort | undefined {
    const patchedModelInfo = applyModelInfoOverrides(modelId, modelInfo, config);
    if (patchedModelInfo?.supports_reasoning === false) {
        return undefined;
    }

    const override = findOverride(modelId, config);

    if (override) {
        if (override.defaultEffort) {
            return override.defaultEffort;
        }

        const efforts = getEffectiveEffortsFromModelInfo(patchedModelInfo);
        return efforts.includes(CANONICAL_DEFAULT_EFFORT)
            ? CANONICAL_DEFAULT_EFFORT
            : getDefaultReasoningEffort(efforts);
    }

    if (patchedModelInfo?.supports_reasoning) {
        return CANONICAL_DEFAULT_EFFORT;
    }

    return undefined;
}

export { CANONICAL_REASONING_EFFORTS, CANONICAL_DEFAULT_EFFORT };
export type { ModelOverride } from "../types";
