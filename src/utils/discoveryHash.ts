type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

/**
 * Web-compatible SHA-256 hash using SubtleCrypto.
 * Works in both Node.js (19+) and browser/web extension environments.
 * This is the ONLY supported hash implementation for this extension.
 */
export async function sha256HexAsync(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    // globalThis.crypto.subtle is available in all modern browsers and Node 19+
    // This is the standard Web Crypto API and works in VS Code web extensions
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Synchronous SHA-256 is NOT supported in web environments.
 * Use sha256HexAsync for all hash operations.
 * @throws Error always - sync crypto not available
 */
export function sha256Hex(_input: string): never {
    throw new Error("Synchronous SHA-256 not available in web extension. Use sha256HexAsync.");
}

function toCanonicalJson(value: unknown): CanonicalJson {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => toCanonicalJson(item));
    }

    if (typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, nestedValue]) => nestedValue !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nestedValue]) => [key, toCanonicalJson(nestedValue)] as const);

        return Object.fromEntries(entries);
    }

    return String(value);
}

export function canonicalizeModelInfoResponse(response: { data?: readonly unknown[] }): string {
    const sortedData = [...(response.data ?? [])].sort((left, right) => {
        const leftName =
            typeof (left as { model_name?: unknown }).model_name === "string"
                ? ((left as { model_name?: string }).model_name ?? "")
                : "";
        const rightName =
            typeof (right as { model_name?: unknown }).model_name === "string"
                ? ((right as { model_name?: string }).model_name ?? "")
                : "";

        return leftName.localeCompare(rightName);
    });

    return JSON.stringify(toCanonicalJson(sortedData));
}

export function hashModelInfoResponse(_response: { data?: readonly unknown[] }): string {
    // Note: sync hashing not available in web. Use async version where possible.
    throw new Error("Synchronous hashing not available. Use hashModelInfoResponseAsync.");
}

export async function hashModelInfoResponseAsync(response: { data?: readonly unknown[] }): Promise<string> {
    return sha256HexAsync(canonicalizeModelInfoResponse(response));
}
