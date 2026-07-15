import type { SupportedReasoningEffort } from "../types";
import { Logger } from "./logger";

// Reasoning effort ladder from most to least capable. `undefined` means omit the parameter entirely.
const EFFORT_LADDER: readonly SupportedReasoningEffort[] = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];

function nextLowerEffort(effort: SupportedReasoningEffort): SupportedReasoningEffort | undefined {
    const index = EFFORT_LADDER.indexOf(effort);
    if (index === -1) {
        return undefined;
    }

    return EFFORT_LADDER[index + 1];
}

function getReasoningText(error: unknown): string {
    if (error === null || error === undefined) {
        return "";
    }

    if (typeof error === "string") {
        return error;
    }

    if (typeof error === "object") {
        const maybeMessage = (error as { message?: unknown }).message;
        const maybeBody = (error as { body?: unknown }).body;

        const parts: string[] = [];
        if (typeof maybeMessage === "string") {
            parts.push(maybeMessage);
        }

        if (typeof maybeBody === "string") {
            parts.push(maybeBody);
        } else if (maybeBody && typeof maybeBody === "object") {
            const serialized = JSON.stringify(maybeBody);
            parts.push(serialized);
        }

        return parts.join("\n");
    }

    return "";
}

function getStatusCode(error: unknown): number | undefined {
    if (error && typeof error === "object") {
        const status = (error as { status?: unknown }).status;
        const statusCode = (error as { statusCode?: unknown }).statusCode;
        const numericStatus = typeof status === "number" ? status : undefined;
        const numericStatusCode = typeof statusCode === "number" ? statusCode : undefined;

        return numericStatus ?? numericStatusCode;
    }

    return undefined;
}

const notificationKeys = new Set<string>();

export class EffortFallbackCache {
    private readonly failures: Map<string, Set<SupportedReasoningEffort>>;

    constructor() {
        this.failures = new Map();
    }

    public getEffectiveEffort(
        modelId: string,
        requestedEffort: SupportedReasoningEffort | undefined
    ): SupportedReasoningEffort | undefined {
        Logger.debug(`[getEffectiveEffort] requestedEffort: ${requestedEffort}, modelId: ${modelId}`);
        if (!requestedEffort) {
            Logger.debug(`[getEffectiveEffort] requestedEffort is falsy, returning undefined`);
            return undefined;
        }

        const failedEfforts = this.failures.get(modelId);
        Logger.debug(
            `[getEffectiveEffort] failedEfforts: ${JSON.stringify(Array.from(failedEfforts?.values() ?? []))}`
        );
        let effort: SupportedReasoningEffort | undefined = requestedEffort;

        while (effort && failedEfforts?.has(effort)) {
            effort = nextLowerEffort(effort);
        }

        Logger.debug(`[getEffectiveEffort] returning: ${effort}`);
        return effort;
    }

    public recordFailure(
        modelId: string,
        attemptedEffort: SupportedReasoningEffort | undefined
    ): SupportedReasoningEffort | undefined {
        if (!attemptedEffort) {
            return undefined;
        }

        const failedEfforts = this.failures.get(modelId) ?? new Set<SupportedReasoningEffort>();
        failedEfforts.add(attemptedEffort);
        this.failures.set(modelId, failedEfforts);

        let nextEffort: SupportedReasoningEffort | undefined = nextLowerEffort(attemptedEffort);
        while (nextEffort && failedEfforts.has(nextEffort)) {
            nextEffort = nextLowerEffort(nextEffort);
        }

        return nextEffort;
    }

    public clear(): void {
        this.failures.clear();
        notificationKeys.clear();
    }
}

export function isReasoningError(error: unknown): boolean {
    const status = getStatusCode(error);
    if (status === undefined || status < 400 || status >= 500) {
        return false;
    }

    const text = getReasoningText(error).toLowerCase();
    if (!text) {
        return false;
    }

    Logger.debug(`[isReasoningError] status: ${status}, text: ${text}`);
    return text.includes("reasoning") && (text.includes("effort") || text.includes("parameter"));
}

function buildNotificationKey(modelId: string, originalEffort: SupportedReasoningEffort): string {
    return `${modelId}:${originalEffort}`;
}

export function hasShownReasoningFallbackNotification(
    modelId: string,
    originalEffort: SupportedReasoningEffort
): boolean {
    const key = buildNotificationKey(modelId, originalEffort);
    return notificationKeys.has(key);
}

export function markReasoningFallbackNotified(modelId: string, originalEffort: SupportedReasoningEffort): void {
    const key = buildNotificationKey(modelId, originalEffort);
    notificationKeys.add(key);
}
