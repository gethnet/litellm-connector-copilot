import * as vscode from "vscode";
import type { LiteLLMModelInfo, ModelOverride, SupportedReasoningEffort } from "../types";
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

const CANONICAL_REASONING_EFFORTS: readonly SupportedReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

const CANONICAL_DEFAULT_EFFORT: SupportedReasoningEffort = "medium";

const MODEL_OVERRIDES_SETTING_KEY = "litellm-connector.modelOverrides";

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

function normalizeEfforts(efforts: unknown): SupportedReasoningEffort[] | undefined {
    if (!Array.isArray(efforts)) {
        return undefined;
    }

    const normalized = efforts.filter(isSupportedReasoningEffort);
    return normalized.length > 0 ? normalized : undefined;
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

    const supportsReasoning =
        candidate.supportsReasoning === true ||
        candidate.supportsReasoning === false ||
        candidate.supportsReasoning === null
            ? candidate.supportsReasoning
            : null;

    const reasoningEfforts = normalizeEfforts(candidate.reasoningEfforts);
    const defaultEffort =
        candidate.defaultEffort && isSupportedReasoningEffort(candidate.defaultEffort)
            ? candidate.defaultEffort
            : undefined;

    return {
        match: candidate.match,
        supportsReasoning,
        reasoningEfforts,
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
    const enableModelOverrides = workspaceConfig.get<boolean>("litellm-connector.enableModelOverrides", true);
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
    const override = findOverride(modelId, config);
    const overrideEfforts = override?.reasoningEfforts;

    // Force-mandatory request parameter should win regardless of LiteLLM data
    if (forceMandatory && override) {
        if (override.supportsReasoning === false) {
            return [];
        }
        return overrideEfforts ?? [...CANONICAL_REASONING_EFFORTS];
    }

    if (modelInfo?.supports_reasoning === false) {
        return [];
    }

    // Explicit LiteLLM effort fields are authoritative, including an explicit
    // all-false set. Do this before the generic supports_reasoning fallback so
    // metadata cannot be broadened into the canonical effort ladder.
    const explicitEfforts = getExplicitReasoningEfforts(modelInfo)
        ?.filter(isSupportedReasoningEffort)
        .filter((effort, index, arr) => arr.indexOf(effort) === index);

    if (override?.supportsReasoning === false) {
        return [];
    }

    if (override?.forceMandatory) {
        return overrideEfforts ?? [...CANONICAL_REASONING_EFFORTS];
    }

    if (explicitEfforts !== undefined) {
        return explicitEfforts;
    }

    if (override) {
        // Non-mandatory overrides do not apply when LiteLLM has valid capability data.
        // Models with supports_reasoning: true but no explicit effort flags fall back to
        // canonical efforts, allowing the caller to use DEFAULT_REASONING_EFFORTS or
        // enforce explicit flags based on their own logic.

        // Next priority: Generic reasoning support flag.
        if (modelInfo?.supports_reasoning) {
            return [...CANONICAL_REASONING_EFFORTS];
        }

        // If there is no model info but override explicitly marks reasoning support,
        // allow the override to provide canonical efforts.
        if (override.supportsReasoning === true) {
            return overrideEfforts ?? [...CANONICAL_REASONING_EFFORTS];
        }

        return [];
    }

    if (modelInfo?.supports_reasoning) {
        return [...CANONICAL_REASONING_EFFORTS];
    }

    return [];
}

export function getDefaultEffort(
    modelId: string,
    modelInfo?: LiteLLMModelInfo,
    config?: vscode.WorkspaceConfiguration
): SupportedReasoningEffort | undefined {
    if (modelInfo?.supports_reasoning === false) {
        return undefined;
    }

    const override = findOverride(modelId, config);

    if (override) {
        if (override.supportsReasoning === false) {
            return undefined;
        }

        if (override.defaultEffort) {
            return override.defaultEffort;
        }

        const efforts = override.reasoningEfforts ?? CANONICAL_REASONING_EFFORTS;
        if (override.supportsReasoning === true || modelInfo?.supports_reasoning) {
            if (efforts.includes(CANONICAL_DEFAULT_EFFORT)) {
                return CANONICAL_DEFAULT_EFFORT;
            }
            return getDefaultReasoningEffort(efforts) ?? CANONICAL_DEFAULT_EFFORT;
        }
        return undefined;
    }

    if (modelInfo?.supports_reasoning) {
        return CANONICAL_DEFAULT_EFFORT;
    }

    return undefined;
}

export { CANONICAL_REASONING_EFFORTS, CANONICAL_DEFAULT_EFFORT };
export type { ModelOverride } from "../types";
