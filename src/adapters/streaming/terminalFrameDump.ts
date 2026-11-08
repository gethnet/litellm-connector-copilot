/**
 * Sanitized dump of a /responses terminal frame for abnormal-status triage.
 *
 * Why this exists: when a bridge terminates a stream with `status:
 * "incomplete"` and no `incomplete_details.reason` (observed live 2026-09-25:
 * Fable 5 via LiteLLM, 8 reasoning tokens then cut), the real stop cause — if
 * the bridge preserved it at all — sits under a key our selective extraction
 * (`status` / `incomplete_details` / `error`) doesn't know about. Payload
 * logging truncates at ~200 chars, so those keys are invisible today. These
 * diagnostics must remain useful without trusting arbitrary bridge fields,
 * including their keys. Known enums and counts remain readable; unknown keys
 * and values receive process-local keyed fingerprints. These distinguish
 * bridge causes within a host session but cannot reveal their meanings or be
 * correlated across restarts; readable diagnostics require explicit review.
 */

import { diagnosticHash } from "./diagnosticHash";
import { safeUsageNumber } from "../../utils/safeUsageNumber";

const STATUSES = new Set(["completed", "incomplete", "failed", "refusal", "in_progress", "queued", "cancelled"]);
const OUTPUT_TYPES = new Set([
    "message",
    "reasoning",
    "function_call",
    "computer_call",
    "web_search_call",
    "file_search_call",
]);
// Bridge stop reasons are untrusted; retain only fixed protocol/triage enums.
const STOP_REASONS = new Set([
    "classifier_interrupt",
    "content_filter",
    "end_turn",
    "length",
    "max_output_tokens",
    "max_tokens",
    "stop",
    "stop_sequence",
    "tool_use",
]);
const USAGE_FIELDS = [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "system_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
];
const KNOWN_FIELDS = new Set([
    "status",
    "stop_reason",
    "output",
    "usage",
    "error",
    "incomplete_details",
    "instructions",
]);

function safeEnum(value: unknown, allowed: ReadonlySet<string>): string | undefined {
    return typeof value === "string" ? (allowed.has(value) ? value : "unknown") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hash each unrecognized field separately, preserving key/value relationships. */
function fingerprintFields(record: Record<string, unknown>, prefix: string, fields: string[]): object[] {
    return fields.slice(0, 64).map((key) => {
        let serialized: string | undefined;
        try {
            serialized = JSON.stringify(record[key]);
        } catch {
            // Parsed JSON cannot be cyclic; malformed in-process input must not break streaming.
            serialized = undefined;
        }
        return {
            keyHash: diagnosticHash(JSON.stringify([prefix, key])),
            valueHash: diagnosticHash(serialized),
        };
    });
}

/**
 * Returns a copy of the terminal `response` object safe for untruncated
 * logging. Non-object inputs yield `{}` (nothing useful to dump).
 */
export function sanitizeTerminalFrame(frame: Record<string, unknown> | undefined): Record<string, unknown> {
    try {
        return buildTerminalFrameSummary(frame);
    } catch {
        // Diagnostics can encounter hostile in-process objects; omit the dump
        // rather than exposing values or interrupting the terminal response.
        return {};
    }
}

function buildTerminalFrameSummary(frame: Record<string, unknown> | undefined): Record<string, unknown> {
    if (typeof frame !== "object" || frame === null) {
        return {};
    }

    const dump: Record<string, unknown> = {};
    const diagnostics: object[] = [];
    const status = safeEnum(frame.status, STATUSES);
    if (status !== undefined) {
        dump.status = status;
    }
    if (Object.hasOwn(frame, "stop_reason")) {
        if (typeof frame.stop_reason === "string" && STOP_REASONS.has(frame.stop_reason)) {
            dump.stop_reason = frame.stop_reason;
        } else {
            dump.unknownValueCount = 1;
            diagnostics.push(...fingerprintFields(frame, "response", ["stop_reason"]));
        }
    }
    if (Array.isArray(frame.output)) {
        dump.output = frame.output.map((item) => {
            const record = isRecord(item) ? item : {};
            return { type: safeEnum(record.type, OUTPUT_TYPES), status: safeEnum(record.status, STATUSES) };
        });
    } else if (frame.output !== undefined) {
        dump.outputKind = frame.output === null ? "null" : typeof frame.output;
    }
    if (isRecord(frame.usage)) {
        const usage: Record<string, number> = {};
        for (const key of USAGE_FIELDS) {
            const value = safeUsageNumber(frame.usage[key]);
            if (value !== undefined) {
                usage[key] = value;
            }
        }
        dump.usage = usage;
    }
    if (frame.error !== undefined && frame.error !== null) {
        dump.hasError = true;
        if (isRecord(frame.error)) {
            diagnostics.push(...fingerprintFields(frame.error, "error", Object.keys(frame.error).sort()));
        } else {
            diagnostics.push(...fingerprintFields(frame, "response", ["error"]));
        }
    }
    if (frame.incomplete_details !== undefined && frame.incomplete_details !== null) {
        dump.hasIncompleteDetails = true;
        if (isRecord(frame.incomplete_details)) {
            const details = frame.incomplete_details;
            const reason = safeEnum(details.reason, STOP_REASONS);
            if (reason !== undefined && reason !== "unknown") {
                dump.incompleteReason = reason;
            }
            const fields = Object.keys(details)
                .filter((key) => key !== "reason" || reason === undefined || reason === "unknown")
                .sort();
            diagnostics.push(...fingerprintFields(details, "incomplete_details", fields));
        } else {
            diagnostics.push(...fingerprintFields(frame, "response", ["incomplete_details"]));
        }
    }
    const unknownFields = Object.keys(frame)
        .filter((key) => !KNOWN_FIELDS.has(key))
        .sort();
    const unknownFieldCount = unknownFields.length;
    if (unknownFieldCount > 0) {
        dump.unknownFieldCount = unknownFieldCount;
        diagnostics.push(...fingerprintFields(frame, "response", unknownFields));
    }
    if (diagnostics.length > 0) {
        dump.unknownDiagnostics = diagnostics;
    }
    return dump;
}
