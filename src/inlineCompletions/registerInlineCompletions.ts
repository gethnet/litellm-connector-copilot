import * as vscode from "vscode";

import { ConfigManager } from "../config/configManager";
import { LiteLLMCompletionProvider } from "../providers";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import type { TelemetryService } from "../telemetry/telemetryService";
import { LiteLLMInlineCompletionProvider } from "./liteLLMInlineCompletionProvider";

const INLINE_COMPLETIONS_ENABLED_KEY = "litellm-connector.inlineCompletions.enabled";

export class InlineCompletionsRegistrar implements vscode.Disposable {
    private registration: vscode.Disposable | undefined;
    private readonly configManager: ConfigManager;
    private readonly completionProvider: LiteLLMCompletionProvider;
    private _telemetryService?: TelemetryService;

    constructor(
        secrets: vscode.SecretStorage,
        userAgent: string,
        private readonly context: vscode.ExtensionContext
    ) {
        this.configManager = new ConfigManager(secrets);
        this.completionProvider = new LiteLLMCompletionProvider(secrets, userAgent);
    }

    public initialize(): void {
        // Call async refreshRegistration but don't await - fire and forget
        this.refreshRegistration().catch((err) => {
            Logger.error("Failed to refresh inline completions registration", err);
        });

        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration(INLINE_COMPLETIONS_ENABLED_KEY)) {
                    this.refreshRegistration().catch((err) => {
                        Logger.error("Failed to refresh inline completions registration after config change", err);
                    });
                }
            })
        );
    }

    public setTelemetryService(service: TelemetryService): void {
        this._telemetryService = service;
        this.completionProvider.setTelemetryService(service);
    }

    private async refreshRegistration(): Promise<void> {
        const config = await this.configManager.getConfig();
        const enabled = config.inlineCompletionsEnabled;
        if (!enabled) {
            this.disposeRegistration();
            LiteLLMTelemetry.reportMetric({
                requestId: `ic_reg_${Math.random().toString(36).slice(2, 10)}`,
                model: "n/a",
                status: "failure",
                error: "inline_completions_disabled",
                caller: "inline-completions.registration",
            });
            return;
        }

        if (this.registration) {
            return;
        }

        Logger.info("Registering inline completion provider (LiteLLM)");
        const provider = new LiteLLMInlineCompletionProvider({
            getConfig: () => this.configManager.getConfig(),
            completionProvider: this.completionProvider,
        });

        if (this._telemetryService) {
            provider.setTelemetryService(this._telemetryService);
            this._telemetryService.captureCommandExecuted("inline-completions.registration");
        }

        // Register for all file-backed documents. This is intentionally broad; the provider
        // itself is responsible for returning null when not configured.
        this.registration = vscode.languages.registerInlineCompletionItemProvider(
            [{ scheme: "file" }, { scheme: "untitled" }],
            provider
        );
        this.context.subscriptions.push(this.registration);

        LiteLLMTelemetry.reportMetric({
            requestId: `ic_reg_${Math.random().toString(36).slice(2, 10)}`,
            model: "n/a",
            status: "success",
            caller: "inline-completions.registration",
        });
    }

    private disposeRegistration(): void {
        if (!this.registration) {
            return;
        }
        Logger.info("Disposing inline completion provider (LiteLLM)");
        this.registration.dispose();
        this.registration = undefined;
    }

    dispose(): void {
        this.disposeRegistration();
    }
}
