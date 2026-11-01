import { StructuredLogger } from "../observability/structuredLogger";

interface JsonObject {
    [key: string]: JsonValue;
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

const ERROR_MESSAGE =
    "Request contains invalid UTF-16 in protected protocol data. Start a new chat or remove the affected tool or attachment and retry.";
const ARGUMENT_ERROR =
    "Request contains invalid UTF-16 or invalid JSON in tool arguments. Start a new chat or correct the affected tool input and retry.";

function fail(argument = false): never {
    throw new Error(argument ? ARGUMENT_ERROR : ERROR_MESSAGE);
}

/**
 * Normalizes the actual JSON representation, not the serialized JSON bytes.
 * Unknown fields and keys are protected because they may be protocol identifiers
 * or signed data. Embedded tool arguments are decoded only at their known path.
 * Logs one count-only warning when a request is repaired.
 */
export function normalizeRequestUnicode<T>(request: T): T {
    const json = JSON.stringify(request);
    if (json === undefined) {
        return fail();
    }
    const root = JSON.parse(json) as JsonValue;
    let repaired = 0;

    const matches = (path: (string | number)[], expected: (string | null)[]): boolean =>
        path.length === expected.length &&
        expected.every((part, index) => (part === null ? typeof path[index] === "number" : path[index] === part));

    const visit = (value: JsonValue, path: (string | number)[], text: boolean, argument: boolean): JsonValue => {
        if (typeof value === "string") {
            const wellFormed = value.toWellFormed();
            if (wellFormed === value) {
                return value;
            }
            if (!text) {
                return fail(argument);
            }
            repaired++;
            return wellFormed;
        }
        if (Array.isArray(value)) {
            return value.map((entry, index) => visit(entry, [...path, index], text, argument));
        }
        if (value === null || typeof value !== "object") {
            return value;
        }

        const result: JsonObject = {};
        for (const [key, entry] of Object.entries(value)) {
            if (key.toWellFormed() !== key) {
                return fail(argument);
            }
            const next = [...path, key];
            if (
                !argument &&
                matches(next, ["messages", null, "tool_calls", null, "function", "arguments"]) &&
                typeof entry === "string"
            ) {
                let parsed: JsonValue;
                try {
                    parsed = JSON.parse(entry) as JsonValue;
                } catch {
                    return fail(true);
                }
                visit(parsed, [], false, true);
                Object.defineProperty(result, key, {
                    value: entry,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
                continue;
            }

            const current = value as JsonObject;
            const normalText =
                !argument &&
                (matches(next, ["prompt"]) ||
                    matches(next, ["messages", null, "content"]) ||
                    (matches(next, ["messages", null, "content", null, "text"]) && current.type === "text") ||
                    matches(next, ["stop"]));
            Object.defineProperty(result, key, {
                value: visit(entry, next, normalText, argument),
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
        return result;
    };

    const normalized = visit(root, [], false, false);
    if (repaired > 0) {
        StructuredLogger.warn("request.unicode_repaired", { stringCount: repaired });
    }
    return normalized as T;
}
