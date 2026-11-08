/** Untrusted usage and pricing values are never coerced at diagnostic boundaries. */
export function safeUsageNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
