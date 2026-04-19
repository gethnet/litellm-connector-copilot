import * as vscode from "vscode";
import type { TelemetryService } from "../telemetry/telemetryService";

export class Logger {
    private static channel: vscode.LogOutputChannel;
    private static telemetryService: TelemetryService | undefined;

    public static initialize(context: vscode.ExtensionContext, telemetryService?: TelemetryService): void {
        this.channel = vscode.window.createOutputChannel("LiteLLM", { log: true });
        context.subscriptions.push(this.channel);
        this.telemetryService = telemetryService;
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
            this.telemetryService?.captureException(error);
        } else {
            this.channel?.error(error, ...args);
            // Optional: capture string errors as well?
            // For now, only real Errors go to captureException
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
