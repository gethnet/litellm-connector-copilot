import * as vscode from "vscode";
import type { LiteLLMModelInfo, ModelOverride, SupportedReasoningEffort } from "../types";
import { Logger } from "../utils/logger";
import { getDefaultReasoningEffort } from "../utils/modelCapabilities";
import bundledOverridesSource from "./modelOverrides.json";

const bundledOverridesData: unknown = bundledOverridesSource;

const CANONICAL_REASONING_EFFORTS: readonly SupportedReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
];

const CANONICAL_DEFAULT_EFFORT: SupportedReasoningEffort = "minimal";

const MODEL_OVERRIDES_SETTING_KEY = "litellm-connector.modelOverrides";

let bundledOverridesCache: ModelOverride[] | undefined;

function isSupportedReasoningEffort(value: unknown): value is SupportedReasoningEffort {
    return (
        value === "none" ||
        value === "minimal" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh"
    );
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
    const overrides = getMergedOverrides(config);

    for (const override of overrides) {
        try {
            const regex = new RegExp(override.match);
            if (regex.test(modelId)) {
                return override;
            }
        } catch {
            Logger.warn(`[modelOverrides] Invalid regex at match time: ${override.match}`);
        }
    }

    return undefined;
}

export function getEffectiveEfforts(
    modelId: string,
    modelInfo?: LiteLLMModelInfo,
    config?: vscode.WorkspaceConfiguration
): SupportedReasoningEffort[] {
    const override = findOverride(modelId, config);
    const overrideEfforts = override?.reasoningEfforts;

    if (modelInfo?.supports_reasoning === false) {
        return [];
    }

    if (override) {
        if (override.supportsReasoning === false) {
            return [];
        }

        if (override.supportsReasoning === true) {
            return overrideEfforts ?? [...CANONICAL_REASONING_EFFORTS];
        }

        // supportsReasoning === null → inherit proxy
        if (modelInfo?.supports_reasoning) {
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
