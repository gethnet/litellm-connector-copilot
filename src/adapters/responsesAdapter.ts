import {
	OpenAIChatCompletionRequest,
	LiteLLMResponsesRequest,
	LiteLLMResponseInputItem,
	LiteLLMResponseTool,
	OpenAIChatMessageContentItem,
} from "../types";

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
				let normalizedId = tc.id;
				if (normalizedId && !normalizedId.startsWith("fc_")) {
					normalizedId = `fc_${normalizedId}`;
				}
				toolCallIdMap.set(tc.id, normalizedId);
			}
		} else if (msg.role === "tool" && msg.tool_call_id) {
			let normalizedId = msg.tool_call_id;
			if (normalizedId && !normalizedId.startsWith("fc_")) {
				normalizedId = `fc_${normalizedId}`;
			}
			toolCallIdMap.set(msg.tool_call_id, normalizedId);
		}
	}

	// Second pass: process messages and add tool calls
	for (const msg of messages) {
		if (msg.role === "system") {
			instructions = typeof msg.content === "string" ? msg.content : undefined;
			continue;
		}

		if (msg.role === "user") {
			if (typeof msg.content === "string" && msg.content.trim()) {
				inputArray.push({ type: "message", role: "user", content: msg.content });
			} else if (Array.isArray(msg.content)) {
				for (const item of msg.content) {
					if (item.type === "text" && item.text && item.text.trim()) {
						inputArray.push({ type: "message", role: "user", content: item.text });
					}
				}
			}
		} else if (msg.role === "assistant") {
			// If assistant has tool calls, we add them.
			// If it ALSO has text content, we add that as a message.
			if (typeof msg.content === "string" && msg.content.trim()) {
				inputArray.push({ type: "message", role: "assistant", content: msg.content });
			} else if (Array.isArray(msg.content)) {
				for (const item of msg.content) {
					if (item.type === "text" && item.text && item.text.trim()) {
						inputArray.push({ type: "message", role: "assistant", content: item.text });
					}
				}
			}
			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					const normalizedId = toolCallIdMap.get(tc.id) || tc.id;
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
				const normalizedId =
					toolCallIdMap.get(toolCallId) || (toolCallId.startsWith("fc_") ? toolCallId : `fc_${toolCallId}`);
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
				finalInputArray.push({
					type: "function_call",
					id: call_id,
					call_id: call_id,
					name: "previous_tool_call",
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
	};

	if (requestBody.tools) {
		responsesBody.tools = requestBody.tools
			.map((tool) => {
				const func = tool.function;
				if (!func.name || !func.description || !func.parameters) {
					return null;
				}
				return {
					type: "function" as const,
					name: func.name,
					description: func.description,
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
