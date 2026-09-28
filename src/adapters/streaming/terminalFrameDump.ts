/**
 * Sanitized dump of a /responses terminal frame for abnormal-status triage.
 *
 * Why this exists: when a bridge terminates a stream with `status:
 * "incomplete"` and no `incomplete_details.reason` (observed live 2026-09-25:
 * Fable 5 via LiteLLM, 8 reasoning tokens then cut), the real stop cause — if
 * the bridge preserved it at all — sits under a key our selective extraction
 * (`status` / `incomplete_details` / `error`) doesn't know about. Payload
 * logging truncates at ~200 chars, so those keys are invisible today. This
 * module returns the WHOLE frame with only the bulky/PII-bearing fields
 * removed, so nonstandard bridge keys (`stop_reason`, root-level error
 * variants, proxy annotations) survive into the structured log verbatim.
 *
 * Sanitization contract (see logging-levels instructions):
 *  - `output[]` re-carries all generated content (text, reasoning summaries) —
 *    replaced with `{type, status}` per item so the shape stays visible.
 *  - `instructions` echoes the system prompt — dropped entirely.
 *  - Everything else is UNKNOWN by definition and therefore kept: dropping
 *    unrecognized keys would defeat the purpose of the dump.
 *
 * Terminal frames are small (usage + metadata) and abnormal terminals are
 * rare, so logging the sanitized frame untruncated at `warn` is safe.
 */

/** Compact stand-in for one `output[]` item: shape without content. */
interface OutputItemSummary {
    type: unknown;
    status: unknown;
}

/**
 * Returns a copy of the terminal `response` object safe for untruncated
 * logging. Non-object inputs yield `{}` (nothing useful to dump).
 */
export function sanitizeTerminalFrame(frame: Record<string, unknown> | undefined): Record<string, unknown> {
    if (typeof frame !== "object" || frame === null) {
        return {};
    }

    const dump: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(frame)) {
        if (key === "instructions") {
            // System-prompt echo: never log.
            continue;
        }
        if (key === "output" && Array.isArray(value)) {
            // Content-bearing: keep the item shapes, strip the content.
            dump.output = value.map((item): OutputItemSummary => {
                const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
                return { type: record.type, status: record.status };
            });
            continue;
        }
        // Unknown keys are the payload we're after — keep verbatim. A
        // malformed `output` (non-array) also lands here on purpose: the
        // malformation itself is a triage signal.
        dump[key] = value;
    }
    return dump;
}
