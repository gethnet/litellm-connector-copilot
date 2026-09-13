import type {
    OpenAIChatCompletionRequest,
    OpenAIChatMessage,
    LiteLLMResponsesRequest,
    LiteLLMResponsesContentItem,
    LiteLLMResponseInputItem,
    LiteLLMResponseTool,
    OpenAIChatMessageContentItem,
} from "../types";
import { normalizeToolCallId } from "../utils";
import { Logger } from "../utils/logger";

function getResponsesReasoningEffort(effort: OpenAIChatCompletionRequest["reasoning_effort"]): string | undefined {
    if (typeof effort === "string") {
        return effort === "none" ? undefined : effort;
    }
    return effort?.effort === "none" ? undefined : effort?.effort;
}

/**
 * Translate ONE Chat-Completions content part into its Responses-native
 * counterpart (issue #154):
 *
 *   text      → input_text  { text }
 *   image_url → input_image { image_url: <string> }   (no `detail`; LiteLLM defaults "auto")
 *   file      → input_file  { filename, file_data }
 *
 * The Responses API and LiteLLM's provider bridge only recognise the `input_*`
 * discriminants — forwarding the chat shapes verbatim made bridged providers
 * silently drop attachments. An explicit host `cache_control` stamp is carried
 * across unchanged. Malformed parts (missing URL / data) return `undefined` so
 * the caller can drop them without aborting the whole turn.
 */
function toResponsesContentItem(item: OpenAIChatMessageContentItem): LiteLLMResponsesContentItem | undefined {
    const cacheControl = item.cache_control ? { cache_control: item.cache_control } : {};

    if (item.type === "text" && typeof item.text === "string") {
        return { type: "input_text", text: item.text, ...cacheControl };
    }
    if (item.type === "image_url" && typeof item.image_url?.url === "string") {
        return { type: "input_image", image_url: item.image_url.url, ...cacheControl };
    }
    if (item.type === "file" && typeof item.file?.file_data === "string") {
        return {
            type: "input_file",
            filename: item.file.filename,
            file_data: item.file.file_data,
            ...cacheControl,
        };
    }

    Logger.warn(`[responsesAdapter] Dropping malformed content part: type=${String(item.type)}`);
    return undefined;
}

/** A text part with no cache stamp — the only kind that may collapse into LiteLLM's string shortcut. */
function isPlainInputText(
    part: LiteLLMResponsesContentItem
): part is Extract<LiteLLMResponsesContentItem, { type: "input_text" }> {
    return part.type === "input_text" && part.cache_control === undefined;
}

/**
 * Build exactly ONE `message` input item for a user/assistant turn.
 *
 * - String content is forwarded as-is (empty/whitespace turns are skipped).
 * - Array content is translated part-by-part via `toResponsesContentItem`; a
 *   turn whose parts are ALL un-stamped text collapses to a joined string to
 *   match LiteLLM's canonical shortcut, otherwise the parts array is kept so
 *   images, files, and `cache_control` stamps survive.
 * - LiteLLM requires string-or-array content — never a bare object — and
 *   splitting one turn into several `message` items (the pre-#154 behaviour)
 *   broke the text ↔ image association for vision prompts.
 */
function toMessageInputItem(
    role: "user" | "assistant",
    content: OpenAIChatMessage["content"]
): LiteLLMResponseInputItem | undefined {
    if (typeof content === "string") {
        return content.trim() ? { type: "message", role, content } : undefined;
    }
    if (!Array.isArray(content)) {
        return undefined;
    }

    const parts = content
        .map(toResponsesContentItem)
        .filter((part): part is LiteLLMResponsesContentItem => part !== undefined);
    if (parts.length === 0) {
        return undefined;
    }

    if (parts.every(isPlainInputText)) {
        const text = parts.map((part) => part.text).join("\n");
        return text.trim() ? { type: "message", role, content: text } : undefined;
    }

    Logger.trace(
        `[responsesAdapter] ${role} message with ${parts.length} part(s): ${parts.map((part) => part.type).join(",")}`
    );
    return { type: "message", role, content: parts };
}

/**
 * Transform a chat/completions request body to the responses API format.
 * The responses API uses "input" (array format) instead of "messages".
 * Tools use the SAME standard OpenAI format as chat/completions.
 * @param requestBody The original chat/completions request body
 * @returns Transformed request body for the responses endpoint
 */
export function transformToResponsesFormat(requestBody: OpenAIChatCompletionRequest): LiteLLMResponsesRequest {
    const messages = requestBody.messages;
    const inputArray: LiteLLMResponseInputItem[] = [];
    let instructions: string | undefined;

    const toolCallIdMap = new Map<string, string>();

    // First pass: normalize and map all tool call IDs from assistant messages AND tool messages
    for (const msg of messages) {
        if (msg.role === "assistant" && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                const normalizedId = normalizeToolCallId(tc.id);
                toolCallIdMap.set(tc.id, normalizedId);
                Logger.trace(`[responsesAdapter] Mapped tool call ID: ${tc.id} -> ${normalizedId}`);
            }
        }
        if (msg.tool_call_id) {
            const normalizedId = normalizeToolCallId(msg.tool_call_id);
            toolCallIdMap.set(msg.tool_call_id, normalizedId);
            Logger.trace(`[responsesAdapter] Mapped tool result ID: ${msg.tool_call_id} -> ${normalizedId}`);
        }
    }

    // Second pass: process messages and add tool calls
    // content can be string or ContentItem[] depending on message type
    for (const msg of messages) {
        if (msg.role === "system") {
            if (typeof msg.content === "string") {
                instructions = msg.content;
            } else if (Array.isArray(msg.content)) {
                // Extract text from content items (OpenAI format: { type: "text", text: "..." })
                instructions = msg.content
                    .filter(
                        (item): item is OpenAIChatMessageContentItem & { type: "text"; text: string } =>
                            "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"
                    )
                    .map((item) => item.text)
                    .join(" ");
            }
            continue;
        }

        if (msg.role === "user") {
            const userMessage = toMessageInputItem("user", msg.content);
            if (userMessage) {
                inputArray.push(userMessage);
            }
        } else if (msg.role === "assistant") {
            // Assistant content (if any) becomes ONE message item; thinking blocks
            // and tool calls are appended after it as their own input items.
            const assistantMessage = toMessageInputItem("assistant", msg.content);
            if (assistantMessage) {
                inputArray.push(assistantMessage);
            }
            if (Array.isArray(msg.thinking_blocks)) {
                for (const block of msg.thinking_blocks) {
                    if (block.type === "thinking") {
                        // Emit a `reasoning` input item carrying the visible thinking summary
                        // and the encrypted signature. Anthropic uses the signature to verify
                        // the thinking block was actually produced by the model.
                        inputArray.push({
                            type: "reasoning",
                            id: `reasoning_${inputArray.length}`,
                            summary: [{ type: "summary_text", text: block.thinking }],
                            encrypted_content: block.signature,
                        } as unknown as LiteLLMResponseInputItem);
                        Logger.trace(
                            `[responsesAdapter] Preserving thinking_block (${block.thinking.length} chars, sig ${block.signature.length} bytes)`
                        );
                    } else {
                        // redacted_thinking block: opaque data, no text. The API still
                        // requires it to be passed back unchanged.
                        inputArray.push({
                            type: "reasoning",
                            id: `reasoning_${inputArray.length}`,
                            summary: [],
                            encrypted_content: block.data,
                        } as unknown as LiteLLMResponseInputItem);
                        Logger.trace(
                            `[responsesAdapter] Preserving redacted_thinking block (${block.data.length} bytes)`
                        );
                    }
                }
            }
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    const normalizedId = toolCallIdMap.get(tc.id) || normalizeToolCallId(tc.id);
                    Logger.debug(`[responsesAdapter] Adding function_call: ${tc.function.name} (id: ${normalizedId})`);
                    inputArray.push({
                        type: "function_call",
                        id: normalizedId,
                        call_id: normalizedId,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    });
                }
            }
        } else if (msg.role === "tool") {
            const toolCallId = msg.tool_call_id;
            if (toolCallId) {
                const normalizedId = toolCallIdMap.get(toolCallId) || normalizeToolCallId(toolCallId);
                Logger.debug(`[responsesAdapter] Adding function_call_output (id: ${normalizedId})`);
                const toolContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
                inputArray.push({
                    type: "function_call_output",
                    call_id: normalizedId,
                    output: toolContent || "Success",
                });
            }
        }
    }

    // Third pass: Ensure every function_call_output has a preceding function_call in the inputArray
    // AND ensure they are in the correct order: [call, output, call, output]
    // LiteLLM /responses endpoint is strict about the sequence.
    const finalInputArray: LiteLLMResponseInputItem[] = [];
    const seenCallIds = new Set<string>();

    for (const item of inputArray) {
        if (item.type === "function_call") {
            const id = item.id;
            seenCallIds.add(id);
            Logger.trace(`[responsesAdapter] Final pass function_call id: ${id}`);
            // Ensure both id and call_id are present for compatibility
            finalInputArray.push({
                ...item,
                id: id,
                call_id: id,
            });
        } else if (item.type === "function_call_output") {
            const call_id = item.call_id;
            if (!seenCallIds.has(call_id)) {
                // Synthesize missing call
                Logger.warn(`[responsesAdapter] Synthesizing missing call for output id: ${call_id}`);

                // Try to find the actual tool name from the tools array if possible
                // This helps avoid generic "Tool 1" labels in the UI
                const toolDef = requestBody.tools?.find((t) => t.function.name !== undefined);
                const name = toolDef?.function.name || "previous_tool_call";

                finalInputArray.push({
                    type: "function_call",
                    id: call_id,
                    call_id: call_id,
                    name: name,
                    arguments: "{}",
                });
                seenCallIds.add(call_id);
            }
            finalInputArray.push({
                ...item,
                id: call_id,
                call_id: call_id,
            });
        } else {
            finalInputArray.push(item);
        }
    }

    // Final check: LiteLLM /responses often fails if the LAST item is a function_call
    // without a corresponding function_call_output in the same request,
    // UNLESS it's the very end of the conversation and we want the model to generate.
    // However, if we have a function_call at the end, we should probably ensure it's valid.

    // Only Responses-API parameters are emitted. Chat-only knobs (`max_tokens`,
    // `frequency_penalty`, `presence_penalty`, `stop`, `stream_options`) are
    // filtered by LiteLLM as unknown — so sending them was a silent no-op and the
    // output cap was never enforced on this route. `max_output_tokens` is the
    // Responses-API name for the cap (issue #154).
    const responsesBody: LiteLLMResponsesRequest = {
        model: requestBody.model,
        input: finalInputArray,
        cache_control: requestBody.cache_control,
        stream: requestBody.stream,
        instructions,
        max_output_tokens: requestBody.max_tokens,
        temperature: requestBody.temperature,
        top_p: requestBody.top_p,
        // Preserve the flat compatibility field while also using the endpoint-native
        // shape. Explicit Claude adaptive fields take precedence over `reasoning`.
        reasoning_effort: requestBody.reasoning_effort,
        reasoning: requestBody.thinking
            ? undefined
            : (() => {
                  const effort = getResponsesReasoningEffort(requestBody.reasoning_effort);
                  // summary:"auto" makes OpenAI reasoning models return summary
                  // text; LiteLLM's bridge ignores it for non-OpenAI models
                  // (they always stream reasoning_content). See issue #149.
                  return effort ? { effort, summary: "auto" } : undefined;
              })(),
        thinking: requestBody.thinking,
        output_config: requestBody.output_config,
        extra_body: requestBody.extra_body,
    };

    if (requestBody.tools) {
        responsesBody.tools = requestBody.tools
            .map((tool) => {
                const func = tool.function;
                if (!func.name || !func.parameters) {
                    Logger.warn(
                        `[responsesAdapter] Dropping tool ${func.name || "unknown"} - missing name or parameters`
                    );
                    return null;
                }
                return {
                    type: "function" as const,
                    name: func.name,
                    description: func.description || "", // Allow empty description
                    parameters: func.parameters,
                };
            })
            .filter((t): t is LiteLLMResponseTool => t !== null);
    }

    if (requestBody.tool_choice && responsesBody.tools) {
        responsesBody.tool_choice = requestBody.tool_choice;
    }

    return responsesBody;
}
