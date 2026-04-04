import type * as vscode from "vscode";
import { HookSystem } from "./hookSystem";
import type { TelemetryService } from "../telemetry/telemetryService";
import type { HookPoint, HookContext } from "./types";

/**
 * Connects the v2 observability HookSystem to PostHog telemetry.
 */
export class PostHogHook implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];

    constructor(private readonly telemetryService: TelemetryService) {}

    public initialize(): void {
        // We only need to listen to a few key hook points to capture most telemetry
        this.disposables.push(HookSystem.register("after:transform", this.handleAfterTransform.bind(this)));
    }

    private handleAfterTransform(_point: HookPoint, context: HookContext): void {
        // This is where we have the final response and metadata
        const { modelId, endpoint, caller, metadata } = context;

        // Check if this was a successful request completion
        if (metadata.status === "success" || metadata.tokensOut !== undefined) {
            this.telemetryService.captureRequestCompleted({
                caller,
                model: modelId,
                endpoint,
                durationMs: (metadata.durationMs as number) || 0,
                tokensIn: (metadata.tokensIn as number) || 0,
                tokensOut: (metadata.tokensOut as number) || 0,
            });
        } else if (metadata.error) {
            this.telemetryService.captureRequestFailed({
                caller,
                model: modelId,
                endpoint,
                durationMs: (metadata.durationMs as number) || 0,
                errorType: String(metadata.error),
            });
        }

        // Track trimming if it happened
        if (metadata.trimExecuted === true) {
            this.telemetryService.captureTrimExecuted(
                modelId,
                caller,
                (metadata.originalTokens as number) || 0,
                (metadata.trimmedTokens as number) || 0,
                (metadata.budget as number) || 0
            );
        }
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
