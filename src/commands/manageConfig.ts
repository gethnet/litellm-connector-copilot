import * as vscode from "vscode";
import type { ConfigManager } from "../config/configManager";
import type { LiteLLMProviderBase } from "../providers";
import { MultiBackendClient } from "../adapters";
import type { LiteLLMBackend } from "../types";
import type { TelemetryService } from "../telemetry/telemetryService";

type ModelDiscoveryProvider = LiteLLMProviderBase &
    Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatInformation">;

type BackendQuickPickItem = vscode.QuickPickItem & { backend?: LiteLLMBackend };
type BackendEntryQuickPickItem = vscode.QuickPickItem & { backend: LiteLLMBackend };

function createConfigHandler(
    configManager: ConfigManager,
    provider?: ModelDiscoveryProvider,
    telemetryService?: TelemetryService
) {
    return async () => {
        const config = await configManager.getConfig();

        const items: vscode.QuickPickItem[] = [
            {
                label: "$(settings-gear) Configure Single Backend (Legacy)",
                description: "Basic configuration with one URL and API key",
            },
            {
                label: "$(layers) Manage Multiple Backends",
                description: "Configure multiple named LiteLLM proxy instances",
            },
        ];

        const picked = await vscode.window.showQuickPick(items, {
            title: "LiteLLM Configuration",
            placeHolder: "Choose configuration mode",
        });

        if (!picked) {
            return;
        }

        if (picked.label.includes("Manage Multiple Backends")) {
            await vscode.commands.executeCommand("litellm-connector.manageBackends");
            return;
        }

        const baseUrl = await vscode.window.showInputBox({
            title: `LiteLLM Base URL`,
            prompt: config.url
                ? "Update your LiteLLM base URL"
                : "Enter your LiteLLM base URL (e.g., http://localhost:4000 or https://api.litellm.ai)",
            ignoreFocusOut: true,
            value: config.url,
            placeHolder: "http://localhost:4000",
        });

        if (baseUrl === undefined) {
            return;
        }

        let apiKey = await vscode.window.showInputBox({
            title: `LiteLLM API Key`,
            prompt: config.key
                ? "Update your LiteLLM API key"
                : "Enter your LiteLLM API key (leave empty if not required)",
            ignoreFocusOut: true,
            password: true,
            // Show empty to avoid leaking in plain text.
            value: "",
            placeHolder: config.key ? "••••••••••••••••" : "Enter API Key",
        });

        if (apiKey === undefined) {
            return;
        }

        // If user enters the magic string, show the actual API key in plain text
        if (apiKey.trim() === "thisisunsafe" && config.key) {
            apiKey = await vscode.window.showInputBox({
                title: `LiteLLM API Key`,
                prompt: "Your API key (unmasked)",
                ignoreFocusOut: true,
                password: false,
                value: config.key,
                placeHolder: "Your API key",
            });

            if (apiKey === undefined) {
                return;
            }
        }

        // If user didn't change the value (left it blank/placeholder), keep the old key
        const newKey = apiKey.trim();
        const finalKey = newKey === "" ? config.key : newKey || undefined;

        await configManager.setConfig({
            url: baseUrl.trim(),
            key: finalKey,
        });
        await configManager.reportFeatureToggles("config_change");

        if (telemetryService) {
            telemetryService.captureConfigChanged("baseUrl", "legacy-manage");
            if (finalKey) {
                telemetryService.captureConfigChanged("apiKey", "legacy-manage");
            }
        }

        // Trigger a model discovery refresh if a provider is available
        if (provider) {
            try {
                provider.clearModelCache();
                await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
                provider.refreshModelInformation();
            } catch (err) {
                console.error("Failed to refresh models after config change", err);
            }
        }

        vscode.window.showInformationMessage(`LiteLLM configuration saved.`);
    };
}

export function registerManageConfigCommand(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    provider?: ModelDiscoveryProvider,
    telemetryService?: TelemetryService
) {
    return vscode.commands.registerCommand(
        "litellm-connector.manage",
        createConfigHandler(configManager, provider, telemetryService)
    );
}

export function registerManageBackendsCommand(
    configManager: ConfigManager,
    provider?: ModelDiscoveryProvider,
    telemetryService?: TelemetryService
) {
    return vscode.commands.registerCommand("litellm-connector.manageBackends", async () => {
        let activeBackendName: string | undefined;

        while (true) {
            const backends = await configManager.listBackends();

            const backendItems: BackendEntryQuickPickItem[] = backends.map((b) => ({
                label: `${b.enabled !== false ? "$(check)" : "$(x)"} ${b.name}`,
                description: b.url,
                detail: b.enabled !== false ? "Enabled" : "Disabled",
                backend: b,
            }));

            const items: BackendQuickPickItem[] = [
                { label: "$(add) Add Backend", alwaysShow: true },
                { label: "$(sync) Check All Connections", alwaysShow: true },
                ...backendItems,
            ];

            const picked = await vscode.window.showQuickPick(items, {
                title: "LiteLLM Backend Management",
                placeHolder: "Select a backend to manage or add a new one",
                ...(activeBackendName
                    ? { activeItems: backendItems.filter((item) => item.backend.name === activeBackendName) }
                    : {}),
            });

            if (!picked) {
                return;
            }

            if (picked.label.includes("Add Backend")) {
                activeBackendName = undefined;
                await addNewBackend(configManager, provider, telemetryService);
                continue;
            }

            if (picked.label.includes("Check All Connections")) {
                activeBackendName = undefined;
                await vscode.commands.executeCommand("litellm-connector.checkConnection");
                continue;
            }

            const backend = (picked as BackendQuickPickItem).backend;
            if (!backend) {
                return;
            }

            activeBackendName = backend.name;
            const shouldReopen = await manageExistingBackend(configManager, backend, provider, telemetryService);

            if (!shouldReopen) {
                return;
            }
        }
    });
}

async function addNewBackend(
    configManager: ConfigManager,
    provider?: ModelDiscoveryProvider,
    telemetryService?: TelemetryService
) {
    const name = await vscode.window.showInputBox({
        title: "Add LiteLLM Backend",
        prompt: "Enter a unique name for this backend (e.g., Cloud, Local)",
        placeHolder: "Cloud",
        validateInput: (value) => (value.trim().length === 0 ? "Name is required" : null),
    });

    if (!name) {
        return;
    }

    const url = await vscode.window.showInputBox({
        title: `Backend URL for "${name}"`,
        prompt: "Enter the base URL of the LiteLLM proxy",
        placeHolder: "http://localhost:4000",
        validateInput: (value) => (value.trim().length === 0 ? "URL is required" : null),
    });

    if (!url) {
        return;
    }

    const apiKey = await vscode.window.showInputBox({
        title: `API Key for "${name}"`,
        prompt: "Enter the API key for this backend (leave empty if none)",
        password: true,
    });

    try {
        await configManager.addBackend({ name: name.trim(), url: url.trim(), enabled: true }, apiKey?.trim());
        vscode.window.showInformationMessage(`Backend "${name}" added.`);

        if (telemetryService) {
            const currentBackends = await configManager.listBackends();
            telemetryService.captureBackendAdded(currentBackends.length);
        }

        if (provider) {
            provider.clearModelCache();
            await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to add backend: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function manageExistingBackend(
    configManager: ConfigManager,
    backend: LiteLLMBackend,
    provider?: ModelDiscoveryProvider,
    telemetryService?: TelemetryService
): Promise<boolean> {
    const items: (vscode.QuickPickItem & { id: string })[] = [
        {
            label: backend.enabled !== false ? "$(x) Disable Backend" : "$(check) Enable Backend",
            id: "toggle",
        },
        { label: "$(edit) Edit URL", id: "edit_url" },
        { label: "$(key) Update API Key", id: "edit_key" },
        { label: "$(trash) Remove Backend", id: "remove" },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: `Manage Backend: ${backend.name}`,
    });

    if (!picked) {
        return true;
    }

    const action = picked.id;

    if (action === "toggle") {
        await configManager.updateBackend(backend.name, { enabled: backend.enabled === false });
        if (telemetryService) {
            telemetryService.captureConfigChanged("backend.enabled", "manage-backends");
        }
        return true;
    }

    if (action === "edit_url") {
        const newUrl = await vscode.window.showInputBox({
            title: `Update URL for "${backend.name}"`,
            value: backend.url,
        });
        if (newUrl === undefined) {
            return false;
        }

        const trimmedUrl = newUrl.trim();
        if (trimmedUrl.length > 0) {
            await configManager.updateBackend(backend.name, { url: trimmedUrl });
            if (telemetryService) {
                telemetryService.captureConfigChanged("backend.url", "manage-backends");
            }
            await refreshModelsAfterBackendChange(configManager, provider);
        }

        return true;
    }

    if (action === "edit_key") {
        const newKey = await vscode.window.showInputBox({
            title: `Update API Key for "${backend.name}"`,
            password: true,
        });
        if (newKey !== undefined) {
            await configManager.updateBackend(backend.name, {}, newKey.trim());
            if (telemetryService) {
                telemetryService.captureConfigChanged("backend.apiKey", "manage-backends");
            }
            await refreshModelsAfterBackendChange(configManager, provider);
        }

        return true;
    }

    if (action === "remove") {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to remove the backend "${backend.name}"?`,
            { modal: true },
            "Remove"
        );
        if (confirm === "Remove") {
            await configManager.removeBackend(backend.name);
            if (telemetryService) {
                const currentBackends = await configManager.listBackends();
                telemetryService.captureBackendRemoved(currentBackends.length);
            }
            await refreshModelsAfterBackendChange(configManager, provider);
            return false;
        }
    }

    return true;
}

async function refreshModelsAfterBackendChange(
    configManager: ConfigManager,
    provider?: ModelDiscoveryProvider
): Promise<void> {
    if (!provider) {
        return;
    }

    provider.clearModelCache();

    try {
        await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        provider.refreshModelInformation();
    } catch (err) {
        console.error("Failed to refresh models after backend change", err);
    }
}

export function registerShowModelsCommand(provider: LiteLLMProviderBase, telemetryService?: TelemetryService) {
    return vscode.commands.registerCommand("litellm-connector.showModels", async () => {
        if (telemetryService) {
            telemetryService.captureCommandExecuted("litellm-connector.showModels");
        }
        const models = provider.getLastKnownModels();
        if (!models.length) {
            vscode.window.showInformationMessage(
                "No cached models yet. Run 'LiteLLM: Reload Models' (or open the provider settings) to fetch models from LiteLLM."
            );
            return;
        }

        type ModelQuickPickItem = vscode.QuickPickItem & { modelId: string };

        // Show a quick pick list with user-facing backend:model label.
        // Copy the internal routable model id to the clipboard.
        const picked = await vscode.window.showQuickPick(
            models
                .slice()
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((m) => ({
                    label: m.name,
                    description: m.name !== m.id ? m.name : undefined,
                    detail: m.tooltip,
                    modelId: m.id,
                })) as ModelQuickPickItem[],
            {
                title: "LiteLLM: Available Models (cached)",
                placeHolder: "Select a model to copy its id to clipboard",
                matchOnDescription: true,
                matchOnDetail: true,
            }
        );

        if (!picked) {
            return;
        }

        await vscode.env.clipboard.writeText(picked.modelId);
        vscode.window.showInformationMessage(`Copied model id: ${picked.modelId}`);
    });
}

export function registerReloadModelsCommand(provider: ModelDiscoveryProvider, telemetryService?: TelemetryService) {
    return vscode.commands.registerCommand("litellm-connector.reloadModels", async () => {
        if (telemetryService) {
            telemetryService.captureCommandExecuted("litellm-connector.reloadModels");
        }
        provider.clearModelCache();
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "LiteLLM: Reloading models",
                    cancellable: false,
                },
                async () => {
                    // Trigger a fresh discovery request. VS Code will call discovery when it needs it,
                    // but we do it proactively so completions pick up new models immediately.
                    await provider.provideLanguageModelChatInformation(
                        { silent: true },
                        new vscode.CancellationTokenSource().token
                    );
                }
            );

            const count = provider.getLastKnownModels().length;
            vscode.window.showInformationMessage(`LiteLLM: Reloaded ${count} models.`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`LiteLLM: Model reload failed: ${msg}`);
        }
    });
}

export function registerCheckConnectionCommand(configManager: ConfigManager, telemetryService?: TelemetryService) {
    return vscode.commands.registerCommand("litellm-connector.checkConnection", async () => {
        if (telemetryService) {
            telemetryService.captureCommandExecuted("litellm-connector.checkConnection");
        }
        const backends = await configManager.resolveBackends();
        if (backends.length === 0) {
            vscode.window.showWarningMessage("No enabled backends configured.");
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "LiteLLM: Checking connections",
                cancellable: true,
            },
            async (_progress, token) => {
                const multiClient = new MultiBackendClient(backends, "litellm-connector-copilot");
                try {
                    const results = await multiClient.checkConnectionAll(token);
                    const successCount = results.filter((r) => !r.error).length;
                    const details = results
                        .map(
                            (r) => `${r.backendName}: ${r.error ? `$(error) ${r.error}` : `$(check) ${r.latencyMs}ms`}`
                        )
                        .join("\n");

                    if (successCount === results.length) {
                        vscode.window.showInformationMessage(`LiteLLM: All ${results.length} connections successful!`);
                    } else {
                        vscode.window.showWarningMessage(
                            `LiteLLM: ${successCount}/${results.length} connections successful.\n\n${details}`
                        );
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`LiteLLM: Connection check failed: ${msg}`);
                }
            }
        );
    });
}

export function registerResetConfigCommand(
    configManager: ConfigManager,
    provider?: LiteLLMProviderBase,
    telemetryService?: TelemetryService,
    reRegisterProvider?: () => void | Promise<void>
) {
    return vscode.commands.registerCommand("litellm-connector.reset", async () => {
        if (telemetryService) {
            telemetryService.captureCommandExecuted("litellm-connector.reset");
        }
        const confirmed = await vscode.window.showWarningMessage(
            "Are you sure you want to reset ALL LiteLLM configuration? This will clear your Base URL, API Key, and all custom settings.",
            { modal: true },
            "Reset All"
        );

        if (confirmed === "Reset All") {
            try {
                await configManager.cleanupAllConfiguration();
                if (provider) {
                    provider.clearModelCache();
                    //provider.refreshModelInformation();
                }

                // Hard reset the provider registration to force VS Code to drop cached models
                if (reRegisterProvider) {
                    await reRegisterProvider();
                }

                vscode.window.showInformationMessage("LiteLLM configuration has been reset.");
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`LiteLLM: Reset failed: ${msg}`);
            }
        }
    });
}
