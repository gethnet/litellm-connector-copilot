import type {
    OpenAIChatCompletionRequest,
    LiteLLMResponsesRequest,
    LiteLLMResponseInputItem,
    LiteLLMResponseTool,
    OpenAIChatMessageContentItem,
} from "../types";
import { normalizeToolCallId } from "../utils";
import { Logger } from "../utils/logger";

/**
 * Transform a chat/completions request body to the responses API format.
 * The responses API uses "input" (array format) instead of "messages".
 * Tools use the SAME standard OpenAI format as chat/completions.
 * @param requestBody The original chat/completions request body
 * @returns Transformed request body for the responses endpoint
 */
export function transformToResponsesFormat(requestBody: OpenAIChatCompletionRequest): LiteLLMResponsesRequest {
    const messages = requestBody.messages;
    const inputArray: (OpenAIChatMessageContentItem | LiteLLMResponseInputItem)[] = [];
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
            if (typeof msg.content === "string" && msg.content.trim()) {
                inputArray.push({ type: "message", role: "user", content: msg.content });
            } else if (Array.isArray(msg.content)) {
                // Unpack content array into individual message items
                for (const contentItem of msg.content) {
                    if (contentItem.type === "text" && typeof contentItem.text === "string") {
                        inputArray.push({
                            type: "message",
                            role: "user",
                            content: contentItem.text,
                        });
                    } else if (contentItem.type === "image_url" && contentItem.image_url?.url) {
                        Logger.debug(
                            `[responsesAdapter] User image: type=${contentItem.type}, url=${contentItem.image_url.url.substring(0, 50)}...`
                        );
                        // LiteLLM /responses requires content to be a string or array — NOT a bare dict.
                        // Wrap the content item in an array to avoid ValueError: Invalid content type: <class 'dict'>
                        inputArray.push({
                            type: "message",
                            role: "user",
                            content: [contentItem],
                        } as unknown as LiteLLMResponseInputItem);
                    }
                }
            }
        } else if (msg.role === "assistant") {
            // If assistant has tool calls, we add them.
            // If it ALSO has content, we add that as a message with text or image_url items.
            if (typeof msg.content === "string" && msg.content.trim()) {
                inputArray.push({ type: "message", role: "assistant", content: msg.content });
            } else if (Array.isArray(msg.content)) {
                // Unpack content array into individual message items
                for (const contentItem of msg.content) {
                    if (contentItem.type === "text" && typeof contentItem.text === "string") {
                        inputArray.push({
                            type: "message",
                            role: "assistant",
                            content: contentItem.text,
                        });
                    } else if (contentItem.type === "image_url" && contentItem.image_url?.url) {
                        Logger.debug(
                            `[responsesAdapter] Assistant image: type=${contentItem.type}, url=${contentItem.image_url.url.substring(0, 50)}...`
                        );
                        // LiteLLM /responses requires content to be a string or array — NOT a bare dict.
                        // Wrap the content item in an array to avoid ValueError: Invalid content type: <class 'dict'>
                        inputArray.push({
                            type: "message",
                            role: "assistant",
                            content: [contentItem],
                        } as unknown as LiteLLMResponseInputItem);
                    }
                }
            }
            if ((msg as { thinking_blocks?: unknown[] }).thinking_blocks) {
                const thinkingBlocks = (
                    msg as {
                        thinking_blocks?: {
                            type?: string;
                            thinking?: string;
                            signature?: string;
                            data?: string;
                        }[];
                    }
                ).thinking_blocks;
                if (Array.isArray(thinkingBlocks)) {
                    for (const block of thinkingBlocks) {
                        if (block && typeof block === "object") {
                            if (typeof block.signature === "string") {
                                // Emit a `reasoning` input item carrying the thinking text
                                // (or empty string for redacted blocks) and the encrypted
                                // signature. Anthropic uses the signature to verify the
                                // thinking block was actually produced by the model.
                                const thinkingText = typeof block.thinking === "string" ? block.thinking : "";
                                inputArray.push({
                                    type: "reasoning",
                                    id: `reasoning_${inputArray.length}`,
                                    summary: thinkingText ? [{ type: "summary_text", text: thinkingText }] : [],
                                    encrypted_content: block.signature,
                                } as unknown as LiteLLMResponseInputItem);
                                Logger.trace(
                                    `[responsesAdapter] Preserving thinking_block (${thinkingText.length} chars, sig ${block.signature.length} bytes)`
                                );
                            } else if (typeof block.data === "string") {
                                // redacted_thinking block: opaque data, no text. The API
                                // still requires it to be passed back unchanged.
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
    const finalInputArray: (OpenAIChatMessageContentItem | LiteLLMResponseInputItem)[] = [];
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

    const responsesBody: LiteLLMResponsesRequest = {
        model: requestBody.model,
        input: finalInputArray,
        stream: requestBody.stream,
        instructions,
        max_tokens: requestBody.max_tokens,
        temperature: requestBody.temperature,
        top_p: requestBody.top_p,
        frequency_penalty: requestBody.frequency_penalty,
        presence_penalty: requestBody.presence_penalty,
        stop: requestBody.stop,
        // LiteLLM /responses also accepts the flat `reasoning_effort` key. We pass it
        // through unchanged so reasoning effort works identically across endpoints
        // and the connector keeps a single canonical request shape.
        reasoning_effort: requestBody.reasoning_effort,
        stream_options: requestBody.stream_options,
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
