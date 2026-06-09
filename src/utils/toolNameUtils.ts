import { Logger } from "./logger";
import { StructuredLogger } from "../observability/structuredLogger";

/**
 * Maximum allowed length for tool function names in the Bedrock Converse API.
 *
 * AWS Bedrock enforces a 64-character limit on the toolUse.name field.
 * This constant is exposed for use at all outbound boundaries where tool names
 * are emitted: v1 message converter, v2 message converter, and streaming interpreter.
 */
export const TOOL_NAME_MAX_LENGTH = 64;

/**
 * Result of sanitizing a tool function name to comply with Bedrock's 64-char limit.
 *
 * Only locally named tools (caller-declared) should use this during the `tools`
 * schema conversion in `convertTools`. For model-declared tool calls streamed
 * from LiteLLM, the streaming interpreter uses a separate logging hook with a
 * `source: "model_stream"` flag to distinguish origins.
 */
export interface SanitizedToolName {
    /**
     * The sanitized name, guaranteed to be ≤64 characters.
     */
    name: string;
    /**
     * Whether the name was actually changed due to exceeding the length limit.
     * True only when `originalLength > TOOL_NAME_MAX_LENGTH`.
     */
    wasTruncated: boolean;
}

/**
 * Sanitizes and truncates a tool function name to comply with AWS Bedrock's 64-character limit.
 *
 * This function is applied at **outbound boundaries** where tool names are emitted:
 * 1. **v1 message converter** (`src/adapters/messageConverter.ts`): `toOpenAIToolCall`
 * 2. **v2 message converter** (`src/adapters/v2OpenAIMessageConverter.ts`): `toOpenAIToolCall`
 * 3. **streaming interpreter** (`src/adapters/streaming/liteLLMStreamInterpreter.ts`):
 *    - `state.toolCallBuffers` initialization (OpenAI format)
 *    - `state.responseToolCallBuffers` updates (output_item.delta)
 *    - `state.responseToolCallBuffers` updates (output_tool_call.*)
 *    - `state.anonymousResponseToolName` updates
 *
 * **Goal**: Prevent `litellm.BadRequestError` for Bedrock Converse API failures when
 *       a tool name exceeds the 64-character limit.
 *
 * **Side Effects**: Emits a log (requested by the user) so that we can diagnose
 *       whether the long name originated from the model or from caller-declared `tools`.
 *
 * @param name - Tool function name to sanitize. Must be a string; non-string values
 *        are normalized to `"tool"` and treated as not truncated.
 * @returns A `SanitizedToolName` with the length-bounded name and an indicator
 *        of whether truncation actually occurred.
 *
 * **Logging**: When `name` is a string longer than 64 characters, a warning is emitted
 *       with a structured payload including `originalLength`, `sanitizedLength`,
 *       and `truncated`. The log keys differ between legacy `Logger.warn` (for
 *       v1 converter) and `StructuredLogger.warn` (for v2 and streaming sites).
 */
export function sanitizeToolName(name: unknown): SanitizedToolName {
    if (typeof name !== "string" || !name) {
        return { name: "tool", wasTruncated: false };
    }

    const originalLength = name.length;
    let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!/^[a-zA-Z]/.test(sanitized)) {
        sanitized = `tool_${sanitized}`;
    }
    sanitized = sanitized.replace(/_+/g, "_");

    // Always enforce the 64-char limit; the Bedrock Converse API will reject longer names.
    const matched = sanitized.match(/^.{1,64}$/);
    if (!matched) {
        // Name exceeds limit: truncate to exactly 64 characters.
        const truncated = sanitized.slice(0, TOOL_NAME_MAX_LENGTH);

        // Emit a warning with structured payload for v1 converter (Logger.warn variant).
        logToolNameTruncationLegacy({
            originalName: name,
            data: {
                originalLength,
                sanitizedLength: truncated.length,
                truncated,
                source:
                    // For v1 converter, we assume a caller-declared tool (source: "caller").
                    // For v2 converter, the `source` is set explicitly to "model_stream".
                    // When the source unknown, we default to "caller" as the safer assumption.
                    // The user requested logging to diagnose the origin, so we include all
                    // context in the payload.
                    "unknown",
            },
        });

        // Return a truncated result; the log above provides diagnostic context.
        return { name: truncated, wasTruncated: true };
    }

    // Name is within limit: no truncation needed.
    // Emit a trace-level log to confirm we passed through this boundary without issues.
    Logger.trace("[sanitizeToolName]", { name, length: originalLength });

    return { name: sanitized, wasTruncated: false };
}

/**
 * Legacy-style logging for tool name truncation (v1 message converter).
 *
 * Uses the `Logger.warn` API, which accepts a message and variadic args.
 * The second argument is an object that will be forwarded to the output channel as structured data.
 */
export function logToolNameTruncationLegacy(args: {
    originalName: string;
    /** Optional: If provided, this overrides the unknown-or-source detection in sanitizeToolName */
    source?: string;
    /** Optional: Additional context structure (recommended over arbitrary extra logs) */
    data?: {
        originalLength: number;
        sanitizedLength: number;
        truncated: string;
        source?: string;
    };
}): void {
    if (!args.data) {
        args.data = {
            originalLength: args.originalName.length,
            sanitizedLength: 0,
            truncated: "",
            source: args.source ?? "unknown",
        };
    }

    Logger.warn("[sanitizeToolName] name exceeds Bedrock's 64-character limit", args.data);
}

/**
 * Structured-style logging for tool name truncation (v2 message converter and streaming interpreter).
 *
 * Uses the `StructuredLogger.warn` API, which emits a JSONL entry with log keys like `stream.tool_name_truncated`.
 * The output channel for this logger is "LiteLLM Structured", separate from the legacy Logger.
 */
export function logToolNameTruncationStructured(args: {
    originalName: string;
    /** Override/confirm the source field (should be "model_stream" for streaming boundaries) */
    source: string;
    /** Optional: Additional context structure (recommended over arbitrary extra logs) */
    data?: {
        originalLength: number;
        sanitizedLength: number;
        endpoint?: string;
    };
}): void {
    if (!args.data) {
        args.data = {
            originalLength: args.originalName.length,
            sanitizedLength: 0,
            endpoint: undefined,
        };
    }

    StructuredLogger.warn("stream.tool_name_truncated", {
        name: args.originalName,
        source: args.source,
        ...args.data,
    });
}
