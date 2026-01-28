import * as vscode from "vscode";
import {
	LiteLLMConfig,
	LiteLLMModelInfoResponse,
	OpenAIChatCompletionRequest,
	LiteLLMResponsesRequest,
	LiteLLMResponseInputItem,
	LiteLLMResponseTool,
	OpenAIChatMessageContentItem,
} from "../types";

export class LiteLLMClient {
	constructor(
		private readonly config: LiteLLMConfig,
		private readonly userAgent: string
	) {}

	/**
	 * Fetches model information from the LiteLLM proxy.
	 */
	async getModelInfo(token?: vscode.CancellationToken): Promise<LiteLLMModelInfoResponse> {
		const controller = new AbortController();
		if (token) {
			token.onCancellationRequested(() => controller.abort());
		}

		const resp = await fetch(`${this.config.url}/model/info`, {
			headers: this.getHeaders(),
			signal: controller.signal,
		});
		if (!resp.ok) {
			throw new Error(`Failed to fetch model info: ${resp.status} ${resp.statusText}`);
		}
		return resp.json() as Promise<LiteLLMModelInfoResponse>;
	}

	/**
	 * Sends a chat request to the LiteLLM proxy.
	 */
	async chat(
		request: OpenAIChatCompletionRequest,
		mode?: string,
		token?: vscode.CancellationToken
	): Promise<ReadableStream<Uint8Array>> {
		const endpoint = this.getEndpoint(mode);
		let body: OpenAIChatCompletionRequest | LiteLLMResponsesRequest = request;

		if (endpoint === "/responses") {
			body = this.transformToResponsesFormat(request);
		}

		const response = await this.fetchWithRateLimit(
			`${this.config.url}${endpoint}`,
			{
				method: "POST",
				headers: this.getHeaders(),
				body: JSON.stringify(body),
			},
			{ token }
		);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`LiteLLM API error: ${response.status} ${response.statusText}\n${errorText}`);
		}

		if (!response.body) {
			throw new Error("No response body from LiteLLM API");
		}

		return response.body as ReadableStream<Uint8Array>;
	}

	private getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"User-Agent": this.userAgent,
		};
		if (this.config.key) {
			headers.Authorization = `Bearer ${this.config.key}`;
			headers["X-API-Key"] = this.config.key;
		}
		return headers;
	}

	private getEndpoint(mode?: string): string {
		if (mode === "chat" || mode === "completions") {
			return "/chat/completions";
		}
		if (mode === "responses") {
			return "/responses";
		}
		// Default to chat/completions for backward compatibility
		return "/chat/completions";
	}

	private async fetchWithRetry(
		url: string,
		init: RequestInit,
		options?: { retries?: number; delayMs?: number; token?: vscode.CancellationToken }
	): Promise<Response> {
		const maxRetries = options?.retries ?? 2;
		const delayMs = options?.delayMs ?? 1000;
		let attempt = 0;
		while (true) {
			if (options?.token?.isCancellationRequested) {
				throw new Error("Operation cancelled by user");
			}

			const controller = new AbortController();
			const disposable = options?.token?.onCancellationRequested(() => controller.abort());

			try {
				const response = await fetch(url, { ...init, signal: controller.signal });
				if (response.ok || attempt >= maxRetries || response.status < 500 || response.status >= 600) {
					return response;
				}
				attempt++;
				await this.sleep(delayMs, options?.token);
			} catch (err: unknown) {
				if (err instanceof Error && err.name === "AbortError") {
					throw new Error("Operation cancelled by user");
				}
				if (attempt >= maxRetries) {
					throw err;
				}
				attempt++;
				await this.sleep(delayMs, options?.token);
			} finally {
				disposable?.dispose();
			}
		}
	}

	/**
	 * Fetch with exponential back-off for rate limiting (429).
	 * Retries with exponential delay up to a maximum cumulative delay of 2 minutes.
	 * For other transient errors, it delegates to {@link fetchWithRetry}.
	 */
	async fetchWithRateLimit(
		url: string,
		init: RequestInit,
		options?: { maxTotalDelayMs?: number; initialDelayMs?: number; token?: vscode.CancellationToken }
	): Promise<Response> {
		const maxTotalDelayMs = options?.maxTotalDelayMs ?? 120_000;
		const initialDelayMs = options?.initialDelayMs ?? 500;
		let cumulativeDelayMs = 0;
		let attempt = 0;

		while (true) {
			if (options?.token?.isCancellationRequested) {
				throw new Error("Operation cancelled by user");
			}

			const response = await this.fetchWithRetry(url, init, { token: options?.token });
			if (response.status !== 429) {
				return response;
			}

			const remaining = maxTotalDelayMs - cumulativeDelayMs;
			if (remaining <= 0) {
				return response;
			}

			const headerDelayMs = this.parseRetryAfterDelayMs(response);
			const exponentialDelayMs = initialDelayMs * Math.pow(2, attempt);
			const chosenDelay = headerDelayMs !== undefined ? headerDelayMs : exponentialDelayMs;
			const nextDelayMs = Math.min(Math.max(1, chosenDelay), remaining);

			attempt++;
			cumulativeDelayMs += nextDelayMs;
			await this.sleep(nextDelayMs, options?.token);
		}
	}

	private sleep(ms: number, token?: vscode.CancellationToken): Promise<void> {
		if (token?.isCancellationRequested) {
			return Promise.reject(new Error("Operation cancelled by user"));
		}
		return new Promise((resolve, reject) => {
			const registration = token?.onCancellationRequested(() => {
				clearTimeout(timer);
				registration?.dispose();
				reject(new Error("Operation cancelled by user"));
			});
			const timer = setTimeout(() => {
				registration?.dispose();
				resolve();
			}, ms);
		});
	}

	private parseRetryAfterDelayMs(response: Response): number | undefined {
		const retryAfter = response.headers.get("retry-after");
		if (retryAfter) {
			const secs = Number(retryAfter);
			if (!Number.isNaN(secs) && secs >= 0) {
				return secs * 1000;
			}
			const asDate = Date.parse(retryAfter);
			if (!Number.isNaN(asDate)) {
				const delta = asDate - Date.now();
				if (delta > 0) {
					return delta;
				}
			}
		}
		return undefined;
	}

	/**
	 * Transform a chat/completions request body to the responses API format.
	 * The responses API uses "input" (array format) instead of "messages".
	 * Tools use the SAME standard OpenAI format as chat/completions.
	 * @param requestBody The original chat/completions request body
	 * @returns Transformed request body for the responses endpoint
	 */
	transformToResponsesFormat(requestBody: OpenAIChatCompletionRequest): LiteLLMResponsesRequest {
		const messages = requestBody.messages;
		const inputArray: (OpenAIChatMessageContentItem | LiteLLMResponseInputItem)[] = [];
		let instructions: string | undefined;

		const toolCallIdMap = new Map<string, string>();
		const toolCallsToAdd = new Set<string>(); // Track which tool calls we will add to inputArray

		// First pass: normalize and map all tool call IDs from assistant messages
		for (const msg of messages) {
			if (msg.role === "assistant" && msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					let normalizedId = tc.id;
					if (normalizedId && !normalizedId.startsWith("fc_")) {
						normalizedId = `fc_${normalizedId}`;
					}
					toolCallIdMap.set(tc.id, normalizedId);
				}
			}
		}

		// Second pass: process messages and add tool calls
		for (const msg of messages) {
			if (msg.role === "system") {
				instructions = typeof msg.content === "string" ? msg.content : undefined;
				continue;
			}

			if (msg.role === "user") {
				if (typeof msg.content === "string") {
					inputArray.push({ type: "message", role: "user", content: msg.content });
				} else if (Array.isArray(msg.content)) {
					for (const item of msg.content) {
						if (item.type === "text" && item.text) {
							inputArray.push({ type: "message", role: "user", content: item.text });
						}
					}
				}
			} else if (msg.role === "assistant") {
				if (typeof msg.content === "string") {
					inputArray.push({ type: "message", role: "assistant", content: msg.content });
				}
				if (msg.tool_calls) {
					for (const tc of msg.tool_calls) {
						const normalizedId = toolCallIdMap.get(tc.id) || tc.id;
						toolCallsToAdd.add(normalizedId);
						inputArray.push({
							type: "function_call",
							id: normalizedId,
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
					// Only add tool output if we've seen the corresponding tool call ID
					if (toolCallsToAdd.has(normalizedId)) {
						inputArray.push({
							type: "function_call_output",
							call_id: normalizedId,
							output: toolContent,
						});
					}
				}
			}
		}

		const responsesBody: LiteLLMResponsesRequest = {
			model: requestBody.model,
			input: inputArray,
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
}
