import * as vscode from "vscode";
import { LiteLLMTelemetry } from "./telemetry";

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
        // Telemetry for warnings (sampling handled in backend)
        LiteLLMTelemetry.reportEvent("logger.warn", { message, args });
    }

    public static error(error: string | Error, ...args: unknown[]): void {
        const err = error instanceof Error ? error : new Error(error);
        this.channel?.error(err.message, ...args, err.stack);
        LiteLLMTelemetry.reportError(err, { args });
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
