import * as vscode from "vscode";
import { LiteLLMChatProvider } from "./providers";
import { ConfigManager } from "./config/configManager";
import {
    registerManageConfigCommand,
    registerReloadModelsCommand,
    registerShowModelsCommand,
    registerCheckConnectionCommand,
} from "./commands/manageConfig";
import { showModelPicker } from "./commands/modelPicker";
import { registerSelectInlineCompletionModelCommand } from "./commands/inlineCompletions";
import { registerGenerateCommitMessageCommand } from "./commands/generateCommitMessage";
import { LiteLLMCommitMessageProvider } from "./providers/liteLLMCommitProvider";
import { Logger } from "./utils/logger";
import { StructuredLogger } from "./observability";
import { PostHogHook } from "./observability/posthogHook";
import { InlineCompletionsRegistrar } from "./inlineCompletions/registerInlineCompletions";
import { TelemetryService } from "./telemetry/telemetryService";
import { LiteLLMTelemetry } from "./utils/telemetry";
import { setTelemetryService as setTokenUtilsTelemetryService } from "./adapters/tokenUtils";
import { EffortFallbackCache } from "./utils/reasoningEffortFallback";

// Store the config manager for cleanup on deactivation
let configManagerInstance: ConfigManager | undefined;
let telemetryServiceInstance: TelemetryService | undefined;

const MODERN_CONFIG_SESSION_KEY = "litellm-connector.isOnModernConfig";
const MIGRATION_NOTICE_KEY = "litellm-connector.migrationNotice.v1";

export function activate(context: vscode.ExtensionContext): void {
    // Initialize telemetry first so logger can use it
    telemetryServiceInstance = new TelemetryService();
    const telemetryService = telemetryServiceInstance;
    telemetryService.initialize(context);
    context.subscriptions.push(telemetryService);

    Logger.initialize(context, telemetryService);
    Logger.info("Activating extension...");

    // Bridge to static telemetry class
    LiteLLMTelemetry.setTelemetryService(telemetryService);

    // Bridge to token utils
    setTokenUtilsTelemetryService(telemetryService);

    // Initialize v2 structured logger
    StructuredLogger.initialize(context);

    // Initialize PostHog hook for v2 observability
    const postHogHook = new PostHogHook(telemetryService);
    postHogHook.initialize();
    context.subscriptions.push(postHogHook);

    // Scoped unhandled exception capture (Extension-specific)
    const uncaughtExceptionListener = (error: Error) => {
        if (error?.stack?.includes("litellm-connector-copilot") || error?.stack?.includes("litellm-connector")) {
            telemetryService.captureException(error, {
                caller: "uncaughtException",
                level: "error",
            });
        }
    };

    const unhandledRejectionListener = (reason: unknown) => {
        if (
            reason instanceof Error &&
            (reason?.stack?.includes("litellm-connector-copilot") || reason?.stack?.includes("litellm-connector"))
        ) {
            telemetryService.captureException(reason, {
                caller: "unhandledRejection",
                level: "error",
            });
        }
    };

    process.on("uncaughtException", uncaughtExceptionListener);
    process.on("unhandledRejection", unhandledRejectionListener);

    // Cleanup listeners on deactivation
    context.subscriptions.push({
        dispose: () => {
            process.off("uncaughtException", uncaughtExceptionListener);
            process.off("unhandledRejection", unhandledRejectionListener);
        },
    });

    let ua = "litellm-vscode-chat/unknown VSCode/unknown";
    try {
        // Build a descriptive User-Agent to help quantify API usage
        const ext = vscode.extensions.getExtension("GethNet.litellm-connector-copilot");
        Logger.debug(`Extension object found: ${!!ext}`);
        // Safely extract version with proper type guard
        let extVersion = "unknown";
        if (ext && typeof ext.packageJSON === "object" && ext.packageJSON !== null && "version" in ext.packageJSON) {
            const v = (ext.packageJSON as Record<string, unknown>).version;
            extVersion = typeof v === "string" ? v : "unknown";
        }
        // Keep UA minimal: only extension version and VS Code version
        const vscodeVersionStr = typeof vscode.version === "string" ? vscode.version : "unknown";
        ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersionStr}`;

        // Capture activation
        telemetryService.captureExtensionActivated(extVersion, vscodeVersionStr);
    } catch (uaErr) {
        Logger.error("Failed to build UA", uaErr);
    }

    Logger.info(`UA: ${ua}`);

    configManagerInstance = new ConfigManager(context.secrets);
    const configManager = configManagerInstance;
    configManager.setTelemetryService(telemetryService);

    const showMigrationNoticeOnce = async (): Promise<void> => {
        const alreadyShown = context.globalState.get<boolean>(MIGRATION_NOTICE_KEY, false);
        if (alreadyShown) {
            return;
        }

        await context.globalState.update(MIGRATION_NOTICE_KEY, true);

        const openLanguageModels = "Open Language Models";
        const message =
            "Configuration now lives in VS Code's Language Models view. Use Add Model... to add or edit LiteLLM.";
        const choice = await vscode.window.showInformationMessage(message, openLanguageModels);
        if (choice === openLanguageModels) {
            try {
                await vscode.commands.executeCommand("workbench.action.chat.manage");
            } catch {
                await vscode.commands.executeCommand("workbench.action.openSettings", "@tag:language-model");
            }
        }
    };

    const getModernConfigSessionFlag = (): boolean => {
        return context.workspaceState?.get<boolean>(MODERN_CONFIG_SESSION_KEY, false) === true;
    };

    const persistModernConfigSessionFlag = async (): Promise<boolean> => {
        if (!context.workspaceState) {
            Logger.warn("workspaceState unavailable; cannot persist modern configuration session flag");
            return false;
        }
        await context.workspaceState.update(MODERN_CONFIG_SESSION_KEY, true);
        return true;
    };

    const effortFallbackCache = new EffortFallbackCache();

    // Track feature adoption
    telemetryService.captureFeatureAdoption("chat");
    telemetryService.captureFeatureAdoption("inline-completions");
    telemetryService.captureFeatureAdoption("commit-generation");
    telemetryService.captureFeatureAdoption("model-picker");

    // Emit feature usage snapshot after config is loaded
    void configManager.getConfig().then((config) => {
        telemetryService.captureFeatureUsageSnapshot({
            "inline-completions": config.inlineCompletionsEnabled ?? false,
            "responses-api": config.v2ApiEnabled ?? false,
            "commit-message": !!(config.commitModelIdOverride && config.commitModelIdOverride.length > 0),
            caching: !config.disableCaching,
            "quota-tool-redaction": !config.disableQuotaToolRedaction,
        });
    });

    // VS Code 1.120+ uses the unified chat provider with per-group configuration support.

    void showMigrationNoticeOnce();

    const activeProvider = new LiteLLMChatProvider(context.secrets, ua, effortFallbackCache);
    activeProvider.setTelemetryService(telemetryService);

    const isOnModernConfigAtStartup = getModernConfigSessionFlag();
    telemetryService.captureModernConfigStatus({
        is_on_modern_config: isOnModernConfigAtStartup,
        source: "startup",
    });

    activeProvider.setModernConfigurationDetectedHandler(() => {
        const alreadyMarked = getModernConfigSessionFlag();
        if (alreadyMarked) {
            telemetryService.captureModernConfigStatus({
                is_on_modern_config: true,
                source: "provider_configuration_detected",
            });
            return;
        }

        void (async () => {
            try {
                const persisted = await persistModernConfigSessionFlag();
                if (!persisted) {
                    return;
                }
                Logger.info("Marked session as modern-configured from provider configuration detection");
                telemetryService.captureModernConfigStatus({
                    is_on_modern_config: true,
                    source: "provider_configuration_detected",
                });
            } catch (err: unknown) {
                Logger.error("Failed to persist modern configuration session flag", err);
            }
        })();
    });

    // Commit message provider (version-agnostic)
    const commitProvider = new LiteLLMCommitMessageProvider(context.secrets, ua, effortFallbackCache);
    commitProvider.setTelemetryService(telemetryService);

    // Track active provider registration for hot-swap
    let chatProviderRegistration: vscode.Disposable | undefined;

    const registerProvider = () => {
        try {
            if (chatProviderRegistration) {
                Logger.info("Disposing existing LanguageModelChatProvider registration...");
                chatProviderRegistration.dispose();
                chatProviderRegistration = undefined;
            }

            Logger.info("Registering LanguageModelChatProvider...");
            chatProviderRegistration = vscode.lm.registerLanguageModelChatProvider(
                "litellm-connector",
                activeProvider as unknown as vscode.LanguageModelChatProvider
            );
            if (chatProviderRegistration) {
                context.subscriptions.push(chatProviderRegistration);
                Logger.info("Provider registered successfully.");
            } else {
                Logger.error("registerLanguageModelChatProvider returned undefined/null");
            }
        } catch (err) {
            Logger.error("Failed to register provider", err);
        }
    };

    // Register provider and commands immediately (do not await config)
    registerProvider();

    // Proactively nudge VS Code to call provideLanguageModelChatInformation immediately after
    // registration.  Without this, model discovery (and reasoning-effort schema population) is
    // deferred until the user first opens the model picker.  Firing the change event right after
    // registration causes VS Code to eagerly re-query the provider — this time with the correct
    // per-group options.configuration values, so reasoning capabilities populate on first load.
    setImmediate(() => {
        Logger.info("Post-registration: nudging VS Code to refresh model information...");
        activeProvider.refreshModelInformation();
    });

    // Re-query models after settings updates so newly completed Language Models provider
    // configuration flows are reflected without requiring a reload.
    let refreshModelsTimer: NodeJS.Timeout | undefined;
    const refreshModelInformation = () => {
        if (refreshModelsTimer) {
            clearTimeout(refreshModelsTimer);
        }
        refreshModelsTimer = setTimeout(() => {
            refreshModelsTimer = undefined;
            Logger.info("Configuration changed; refreshing model information...");
            activeProvider.refreshModelInformation();
        }, 250);
    };
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            // Only refresh when LiteLM-specific settings change, not generic provider config
            // (e.affectsConfiguration) returns true for the top-level "litellm-connector.*" path
            if (
                e.affectsConfiguration("litellm-connector.modelOverrides") ||
                e.affectsConfiguration("litellm-connector.backendGroups")
            ) {
                refreshModelInformation();
            }
        })
    );
    context.subscriptions.push({
        dispose: () => {
            if (refreshModelsTimer) {
                clearTimeout(refreshModelsTimer);
                refreshModelsTimer = undefined;
            }
        },
    });

    try {
        context.subscriptions.push(
            registerManageConfigCommand(context, configManager, activeProvider, telemetryService)
        );
        context.subscriptions.push(registerShowModelsCommand(activeProvider, telemetryService));
        context.subscriptions.push(registerReloadModelsCommand(activeProvider, telemetryService));
        context.subscriptions.push(registerCheckConnectionCommand(configManager, telemetryService));
        context.subscriptions
            .push
            // Legacy resetConfig command removed with migration to Language Models UI
            ();
        context.subscriptions.push(registerSelectInlineCompletionModelCommand(activeProvider));
        context.subscriptions.push(registerGenerateCommitMessageCommand(commitProvider, telemetryService));
        context.subscriptions.push(
            vscode.commands.registerCommand("litellm-connector.generateCommitMessage.selectModel", async () => {
                await showModelPicker(commitProvider, {
                    title: "Select Commit Message Model",
                    settingKey: "commitModelIdOverride",
                    telemetryService: telemetryService,
                    caller: "commit-message",
                });
            })
        );
        Logger.info("Config command registered.");
    } catch (cmdErr) {
        Logger.error("Failed to register commands", cmdErr);
    }

    // Stable inline completions (optional; disabled by default)
    const inlineRegistrar = new InlineCompletionsRegistrar(context.secrets, ua, context, effortFallbackCache);
    inlineRegistrar.setTelemetryService(telemetryService);
    inlineRegistrar.initialize();
    context.subscriptions.push(inlineRegistrar);

    // Configuration onboarding is handled via the classic manage command,
    // which routes users directly into multi-backend management.
    // Proactively check configuration and prompt user if missing
    configManager
        .isConfigured()
        .then((configured) => {
            const isOnModernConfig = getModernConfigSessionFlag();
            if (!configured && !isOnModernConfig) {
                Logger.info("Extension not configured. Prompting user...");
                vscode.window
                    .showInformationMessage(
                        "LiteLLM Connector is not configured. Open Language Models to add a LiteLLM provider.",
                        "Open Language Models"
                    )
                    .then((selection) => {
                        if (selection === "Open Language Models") {
                            vscode.commands.executeCommand("workbench.action.chat.manage");
                        }
                    });
            }
        })
        .catch((err) => {
            Logger.error("Error checking configuration status", err);
        });
}

export async function deactivate(): Promise<void> {
    if (configManagerInstance) {
        await configManagerInstance.dispose();
    }
    if (telemetryServiceInstance) {
        // Use shutdown() instead of dispose() for proper async cleanup
        await telemetryServiceInstance.shutdown();
        telemetryServiceInstance.dispose();
    }
}
