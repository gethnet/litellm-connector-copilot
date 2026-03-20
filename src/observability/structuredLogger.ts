import * as vscode from "vscode";
import type { LogLevel, LogEvent, EventType } from "./types";

/**
 * Structured JSONL logger for the v2 provider baseline.
 *
 * Outputs one JSON object per line for parseability by standard tools (jq, etc.).
 * Log level filtering is handled by VS Code's LogOutputChannel UI (the dropdown
 * in the output panel). All logs are sent to the channel; the channel decides
 * what to display based on the user-selected level.
 *
 * Log levels:
 * - trace: Full payloads, raw SSE frames, detailed parameter maps, hook context snapshots
 * - debug: Detailed flow information, endpoint selection decisions, parameter filtering outcomes
 * - info: High-level lifecycle events, request ingress, completion status, token totals
 * - warn: Recoverable issues, parameter suppression, endpoint fallback, trimming near limits
 * - error: Failures and exceptions, request failures, unhandled errors, quota exhaustion
 */
export class StructuredLogger {
    private static channel: vscode.LogOutputChannel | undefined;

    /**
     * Initializes the structured logger with a VS Code output channel.
     *
     * @param context - VS Code extension context for subscription management
     */
    public static initialize(context: vscode.ExtensionContext): void {
        this.channel = vscode.window.createOutputChannel("LiteLLM V2", { log: true });
        context.subscriptions.push(this.channel);
        this.info("logger.initialized", {
            note: "Use the log level dropdown in the output panel to change verbosity",
        });
    }

    /**
     * Sets the current log level.
     *
     * @deprecated Use the log level dropdown in the VS Code output panel instead.
     * This method is kept for backward compatibility but has no effect since
     * log filtering is now handled by the output channel UI.
     *
     * @param _level - New log level (ignored)
     */
    public static setLevel(_level: LogLevel): void {
        // No-op: log level is now controlled by the output channel UI
        this.info("logger.setLevel_called", {
            note: "Log level is now controlled by the output panel dropdown. This call has no effect.",
        });
    }

    /**
     * Checks if a given level would be logged.
     *
     * @deprecated Always returns true since filtering is handled by the output channel.
     * @param _level - Level to check (ignored)
     * @returns Always true
     */
    public static isEnabled(_level: LogLevel): boolean {
        // Always return true - let the output channel handle filtering
        return true;
    }

    /**
     * Logs a structured event at the specified level.
     *
     * All logs are sent to the output channel. The channel's UI dropdown
     * controls what is displayed.
     *
     * @param level - Log level
     * @param event - Event type
     * @param data - Event-specific payload
     * @param options - Optional metadata (requestId, model, endpoint, caller)
     */
    public static log(
        level: LogLevel,
        event: EventType | string,
        data: Record<string, unknown>,
        options?: {
            requestId?: string;
            model?: string;
            endpoint?: string;
            caller?: string;
        }
    ): void {
        const logEvent: LogEvent = {
            timestamp: new Date().toISOString(),
            requestId: options?.requestId ?? "no-request",
            level,
            event: event as EventType,
            data,
            model: options?.model,
            endpoint: options?.endpoint,
            caller: options?.caller,
        };

        const jsonLine = JSON.stringify(logEvent);

        switch (level) {
            case "trace":
                this.channel?.trace(jsonLine);
                break;
            case "debug":
                this.channel?.debug(jsonLine);
                break;
            case "info":
                this.channel?.info(jsonLine);
                break;
            case "warn":
                this.channel?.warn(jsonLine);
                break;
            case "error":
                this.channel?.error(jsonLine);
                break;
        }
    }

    /**
     * Logs at trace level. Outputs the most data.
     * Use for full payloads, raw SSE frames, detailed parameter maps, hook context snapshots.
     */
    public static trace(
        event: EventType | string,
        data: Record<string, unknown>,
        options?: { requestId?: string; model?: string; endpoint?: string; caller?: string }
    ): void {
        this.log("trace", event, data, options);
    }

    /**
     * Logs at debug level.
     * Use for detailed flow information, endpoint selection decisions, parameter filtering outcomes.
     */
    public static debug(
        event: EventType | string,
        data: Record<string, unknown>,
        options?: { requestId?: string; model?: string; endpoint?: string; caller?: string }
    ): void {
        this.log("debug", event, data, options);
    }

    /**
     * Logs at info level.
     * Use for high-level lifecycle events, request ingress, completion status, token totals.
     */
    public static info(
        event: EventType | string,
        data: Record<string, unknown>,
        options?: { requestId?: string; model?: string; endpoint?: string; caller?: string }
    ): void {
        this.log("info", event, data, options);
    }

    /**
     * Logs at warn level.
     * Use for recoverable issues, parameter suppression, endpoint fallback, trimming near limits.
     */
    public static warn(
        event: EventType | string,
        data: Record<string, unknown>,
        options?: { requestId?: string; model?: string; endpoint?: string; caller?: string }
    ): void {
        this.log("warn", event, data, options);
    }

    /**
     * Logs at error level.
     * Use for failures and exceptions, request failures, unhandled errors, quota exhaustion.
     */
    public static error(
        event: EventType | string,
        data: Record<string, unknown>,
        options?: { requestId?: string; model?: string; endpoint?: string; caller?: string }
    ): void {
        this.log("error", event, data, options);
    }

    /**
     * Shows the output channel.
     */
    public static show(): void {
        this.channel?.show();
    }
}
