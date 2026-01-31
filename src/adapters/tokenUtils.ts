import * as vscode from "vscode";
import { LiteLLMModelInfo } from "../types";

export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
export const DEFAULT_CONTEXT_LENGTH = 128000;

/**
 * Roughly estimate tokens for VS Code chat messages (text only)
 */
export function estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatRequestMessage[]): number {
	let total = 0;
	for (const m of msgs) {
		total += estimateSingleMessageTokens(m);
	}
	return total;
}

/**
 * Roughly estimate tokens for a single VS Code chat message (text only)
 */
export function estimateSingleMessageTokens(msg: vscode.LanguageModelChatRequestMessage): number {
	let total = 0;
	for (const part of msg.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			total += Math.ceil(part.value.length / 4);
		}
	}
	return total;
}

/**
 * Rough token estimate for tool definitions by JSON size
 */
export function estimateToolTokens(
	tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined
): number {
	if (!tools || tools.length === 0) {
		return 0;
	}
	try {
		const json = JSON.stringify(tools);
		return Math.ceil(json.length / 4);
	} catch {
		return 0;
	}
}

/**
 * Determine whether a model should use stricter Anthropic-style budgeting.
 */
export function isAnthropicModel(modelId: string, modelInfo?: LiteLLMModelInfo): boolean {
	if (modelInfo?.litellm_provider && /anthropic/i.test(modelInfo.litellm_provider)) {
		return true;
	}
	return /claude/i.test(modelId) || /anthropic/i.test(modelId);
}

/**
 * Trim messages to fit within the model's input token budget, preserving the system prompt
 * and as much recent context as possible. Anthropic models get a safety margin to avoid
 * overfilling the context window.
 */
export function trimMessagesToFitBudget(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined,
	model: vscode.LanguageModelChatInformation,
	modelInfo?: LiteLLMModelInfo
): readonly vscode.LanguageModelChatRequestMessage[] {
	const toolTokenCount = estimateToolTokens(tools);
	const tokenLimit = Math.max(1, model.maxInputTokens);
	const safetyLimit = isAnthropicModel(model.id, modelInfo) ? Math.max(1, Math.floor(tokenLimit * 0.98)) : tokenLimit;
	const budget = safetyLimit - toolTokenCount;
	if (budget <= 0) {
		throw new Error("Message exceeds token limit.");
	}

	let systemMessage: vscode.LanguageModelChatRequestMessage | undefined;
	const remaining: vscode.LanguageModelChatRequestMessage[] = [];
	const userRole = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const assistantRole = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	for (const msg of messages) {
		const roleNum = msg.role as unknown as number;
		const isSystem = roleNum !== userRole && roleNum !== assistantRole;
		if (!systemMessage && isSystem) {
			systemMessage = msg;
		} else {
			remaining.push(msg);
		}
	}

	const selected: vscode.LanguageModelChatRequestMessage[] = [];
	let used = 0;

	// Detect continuation request
	const lastMessage = remaining.length > 0 ? remaining[remaining.length - 1] : undefined;
	const isContinuation =
		lastMessage?.role === (vscode.LanguageModelChatMessageRole.User as unknown as number) &&
		lastMessage.content.length === 1 &&
		lastMessage.content[0] instanceof vscode.LanguageModelTextPart &&
		lastMessage.content[0].value.trim().toLowerCase() === "continue";

	if (systemMessage) {
		const sysTokens = estimateSingleMessageTokens(systemMessage);
		if (sysTokens > budget) {
			throw new Error("Message exceeds token limit.");
		}
		selected.push(systemMessage);
		used += sysTokens;
	}

	for (let i = remaining.length - 1; i >= 0; i--) {
		const msg = remaining[i];
		const msgTokens = estimateSingleMessageTokens(msg);

		// If it's a continuation, we MUST include the immediately preceding assistant message
		// to provide context for where to resume.
		const isProtectedAssistantMessage =
			isContinuation &&
			i === remaining.length - 2 &&
			msg.role === (vscode.LanguageModelChatMessageRole.Assistant as unknown as number);

		if (used + msgTokens <= budget || selected.length === (systemMessage ? 1 : 0) || isProtectedAssistantMessage) {
			selected.splice(systemMessage ? 1 : 0, 0, msg);
			used += msgTokens;
		} else {
			break;
		}
	}

	return selected;
}
