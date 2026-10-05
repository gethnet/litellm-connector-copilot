export const HARNESS_MODEL_VENDOR_PREFIX = "litellm-connector/";

/**
 * Resolve host wrappers only against complete registered provider IDs.
 * The group is opaque and may contain slashes; its text is not routing authority.
 * Exact identities win, while overlapping registered suffixes fail closed.
 */
export function resolveRegisteredModelId(id: string, entries: ReadonlyMap<string, unknown>): string | undefined {
    if (entries.has(id)) {
        return id;
    }
    if (!id.startsWith(HARNESS_MODEL_VENDOR_PREFIX)) {
        return undefined;
    }

    const remainder = id.slice(HARNESS_MODEL_VENDOR_PREFIX.length);
    if (entries.has(remainder)) {
        return remainder;
    }

    let matched: string | undefined;
    for (const registeredId of entries.keys()) {
        const suffix = `/${registeredId}`;
        if (registeredId.length === 0 || remainder.length <= suffix.length || !remainder.endsWith(suffix)) {
            continue;
        }
        if (matched !== undefined) {
            return undefined;
        }
        matched = registeredId;
    }
    return matched;
}
