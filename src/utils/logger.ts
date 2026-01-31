import * as vscode from "vscode";

export class Logger {
	private static channel: vscode.LogOutputChannel;

	public static initialize(context: vscode.ExtensionContext) {
		this.channel = vscode.window.createOutputChannel("LiteLLM", { log: true });
		context.subscriptions.push(this.channel);
	}

	public static info(message: string, ...args: unknown[]): void {
		this.channel?.info(message, ...args);
	}

	public static warn(message: string, ...args: unknown[]): void {
		this.channel?.warn(message, ...args);
	}

	public static error(error: string | Error, ...args: unknown[]): void {
		if (error instanceof Error) {
			this.channel?.error(error.message, ...args, error.stack);
		} else {
			this.channel?.error(error, ...args);
		}
	}

	public static debug(message: string, ...args: unknown[]): void {
		this.channel?.debug(message, ...args);
	}

	public static trace(message: string, ...args: unknown[]): void {
		this.channel?.trace(message, ...args);
	}

	public static show(): void {
		this.channel?.show();
	}
}
