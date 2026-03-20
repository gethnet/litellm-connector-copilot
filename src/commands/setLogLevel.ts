/**
 * Command to set the log level for the v2 provider baseline.
 *
 * Allows users to change the log level at runtime without restarting the extension.
 */

import * as vscode from "vscode";
import { StructuredLogger } from "../observability/structuredLogger";
import type { LogLevel } from "../observability/types";

/**
 * Registers a command to set the log level for the v2 provider.
 *
 * @returns Disposable for the registered command
 */
export function registerSetLogLevelCommand(): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.setLogLevel", async () => {
        const levels: { label: string; description: string; level: LogLevel }[] = [
            {
                label: "Trace",
                description: "Full payloads, raw SSE frames, detailed parameter maps (most verbose)",
                level: "trace",
            },
            {
                label: "Debug",
                description: "Detailed flow information, endpoint selection decisions",
                level: "debug",
            },
            {
                label: "Info",
                description: "High-level lifecycle events, request ingress, completion status (default)",
                level: "info",
            },
            {
                label: "Warn",
                description: "Recoverable issues, parameter suppression, endpoint fallback",
                level: "warn",
            },
            {
                label: "Error",
                description: "Failures and exceptions only (least verbose)",
                level: "error",
            },
        ];

        const picked = await vscode.window.showQuickPick(levels, {
            placeHolder: "Select the log level for LiteLLM V2 provider",
            title: "LiteLLM V2 Log Level",
        });

        if (!picked) {
            return;
        }

        StructuredLogger.setLevel(picked.level);
        vscode.window.showInformationMessage(`LiteLLM V2 log level set to: ${picked.label}`);

        // Show the output channel so user can see the logs
        StructuredLogger.show();
    });
}
