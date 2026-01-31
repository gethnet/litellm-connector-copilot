import * as vscode from "vscode";
import { LiteLLMConfig, LiteLLMResponsesRequest } from "../types";
import { tryParseJSONObject } from "../utils";

export interface ResponsesEvent {
	type: string;
	delta?: string;
	text?: string;
	chunk?: string;
	item?: Record<string, unknown>;
	choices?: Record<string, unknown>[];
	output?: Record<string, unknown>[];
}

export class ResponsesClient {
	private toolCallBuffer = "";
	private activeToolCallId: string | undefined;
	private activeToolName: string | undefined;

	constructor(
		private readonly config: LiteLLMConfig,
		private readonly userAgent: string
	) {}

	/**
	 * Sends a request to the LiteLLM /responses endpoint and handles the SSE stream.
	 */
	async sendResponsesRequest(
		request: LiteLLMResponsesRequest,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const response = await fetch(`${this.config.url}/responses`, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify(request),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`LiteLLM Responses API error: ${response.status} ${response.statusText}\n${errorText}`);
		}

		if (!response.body) {
			throw new Error("No response body from LiteLLM Responses API");
		}

		await this.parseSSEStream(response.body, progress, token);
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

	private async parseSSEStream(
		stream: ReadableStream<Uint8Array>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done || token.isCancellationRequested) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith("data: ")) {
						continue;
					}

					const data = trimmed.slice(6);
					if (data === "[DONE]") {
						continue;
					}

					try {
						const event = JSON.parse(data) as ResponsesEvent;
						await this.handleEvent(event, progress);
					} catch (e) {
						console.error("[ResponsesClient] Failed to parse SSE data", e, data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	private async handleEvent(
		event: ResponsesEvent,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): Promise<void> {
		const type = event.type;

		// Handle text output
		if (type === "response.output_text.delta") {
			const text = event.delta || event.text || event.chunk;
			if (text) {
				progress.report(new vscode.LanguageModelTextPart(text));
			}
		}
		// Handle reasoning/thought output
		else if (type === "response.output_reasoning.delta") {
			const reasoning = event.delta || event.text || event.chunk;
			if (reasoning) {
				// Format reasoning as italicized text to distinguish it
				progress.report(new vscode.LanguageModelTextPart(`*${reasoning}*`));
			}
		}
		// Handle tool call parts (buffering arguments)
		else if (type === "response.output_item.delta") {
			const item = event.item;
			if (item?.type === "function_call") {
				if (typeof item.call_id === "string") {
					this.activeToolCallId = item.call_id;
				}
				if (typeof item.name === "string") {
					this.activeToolName = item.name;
				}
				if (typeof item.arguments === "string") {
					this.toolCallBuffer += item.arguments;
				}
			}
		}
		// Handle tool call completion
		else if (type === "response.output_item.done") {
			const item = event.item;
			if (item?.type === "function_call") {
				const callId = (typeof item.call_id === "string" ? item.call_id : undefined) || this.activeToolCallId;
				const name = (typeof item.name === "string" ? item.name : undefined) || this.activeToolName;
				const args = (typeof item.arguments === "string" ? item.arguments : undefined) || this.toolCallBuffer;

				if (callId && name && args) {
					const parsed = tryParseJSONObject(args);
					if (parsed.ok) {
						progress.report(new vscode.LanguageModelToolCallPart(callId, name, parsed.value));
					}
				}
				// Reset buffer
				this.toolCallBuffer = "";
				this.activeToolCallId = undefined;
				this.activeToolName = undefined;
			}
		}
	}
}
