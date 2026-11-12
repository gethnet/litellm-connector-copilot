import { sha256 } from "js-sha256";

// A process-local key prevents offline guessing of low-entropy diagnostic values.
// Correlation survives within this host process, but deliberately not restarts.
// Without secure randomness, omit fingerprints rather than use a predictable key.
const key = (() => {
    try {
        return globalThis.crypto.getRandomValues(new Uint8Array(32));
    } catch {
        return undefined;
    }
})();

/** Fingerprint only strings; diagnostic failures must never affect streaming. */
export function diagnosticHash(value: unknown): string | undefined {
    if (typeof value !== "string" || !key) {
        return undefined;
    }
    try {
        return sha256.hmac(key, value);
    } catch {
        // Never expose the raw value or let a fingerprint failure alter a response.
        return undefined;
    }
}
