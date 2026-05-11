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
        const { requestId, modelId, endpoint, caller, metadata } = context;

        // Extract typed metadata with proper guards
        const status = typeof metadata.status === "string" ? metadata.status : undefined;
        const tokensOut = typeof metadata.tokensOut === "number" ? metadata.tokensOut : undefined;
        const tokensIn = typeof metadata.tokensIn === "number" ? metadata.tokensIn : 0;
        const durationMs = typeof metadata.durationMs === "number" ? metadata.durationMs : 0;
        const error = typeof metadata.error === "string" ? metadata.error : undefined;
        const trimExecuted = metadata.trimExecuted === true;
        const originalTokens = typeof metadata.originalTokens === "number" ? metadata.originalTokens : 0;
        const trimmedTokens = typeof metadata.trimmedTokens === "number" ? metadata.trimmedTokens : 0;
        const budget = typeof metadata.budget === "number" ? metadata.budget : 0;

        // Check if this was a successful request completion
        if (status === "success" || tokensOut !== undefined) {
            this.telemetryService.captureRequestCompleted({
                request_id: requestId,
                caller,
                model: modelId,
                endpoint,
                durationMs,
                tokensIn,
                tokensOut: tokensOut ?? 0,
            });
        } else if (error) {
            // Report error
            this.telemetryService.captureRequestFailed({
                request_id: requestId,
                caller,
                model: modelId,
                endpoint,
                durationMs,
                errorType: String(error),
            });
        }

        // Track trimming if it happened
        if (trimExecuted) {
            this.telemetryService.captureTrimExecuted(modelId, caller, originalTokens, trimmedTokens, budget);
        }
    }

    public dispose(): void {
        this.disposables.forEach((d: vscode.Disposable) => {
            d.dispose();
        });
    }
}
