import * as vscode from "vscode";
import { ConfigManager } from "./configManager";
import { StructuredLogger } from "../observability/structuredLogger";
import type { TelemetryService } from "../telemetry/telemetryService";

export interface LegacyBackendConfig {
    readonly id?: string;
    readonly name?: string;
    readonly baseUrl: string;
    readonly apiKey: string;
}

export interface MigrationResult {
    readonly migrated: boolean;
    readonly groupsCreated: number;
    readonly groupNames: string[];
    readonly cleanupComplete: boolean;
    readonly errors: string[];
}

interface LegacyBackendEntry {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly baseUrl?: unknown;
    readonly apiKeySecretRef?: unknown;
    readonly apiKey?: unknown;
}

export class LegacyConfigMigration {
    private static readonly LEGACY_BASE_URL_KEY = "litellm-connector.baseUrl";
    private static readonly LEGACY_BACKENDS_KEY = "litellm-connector.backends";
    private static readonly LEGACY_API_KEY_KEY = "litellm-connector.apiKey";
    private static readonly LEGACY_API_KEY_PREFIX = `${LegacyConfigMigration.LEGACY_API_KEY_KEY}.`;
    private static readonly MIGRATION_COMPLETED_KEY = "litellm-connector.migrationCompleted.v1";

    private readonly configManager: ConfigManager;
    private readonly context: vscode.ExtensionContext;
    private readonly telemetryService?: TelemetryService;

    constructor(context: vscode.ExtensionContext, configManager: ConfigManager, telemetryService?: TelemetryService) {
        this.context = context;
        this.configManager = configManager;
        this.telemetryService = telemetryService;
    }

    public async isMigrationCompleted(): Promise<boolean> {
        return this.context.globalState.get<boolean>(LegacyConfigMigration.MIGRATION_COMPLETED_KEY, false);
    }

    private async markMigrationCompleted(): Promise<void> {
        if (!this.context.globalState) {
            return;
        }
        await this.context.globalState.update(LegacyConfigMigration.MIGRATION_COMPLETED_KEY, true);
    }

    public async detectLegacyConfig(): Promise<boolean> {
        const workspaceConfig = vscode.workspace.getConfiguration();
        const hasSingleBaseUrl = workspaceConfig.has(LegacyConfigMigration.LEGACY_BASE_URL_KEY);
        const hasMultiBackend = workspaceConfig.has(LegacyConfigMigration.LEGACY_BACKENDS_KEY);

        const keys = await this.context.secrets.keys();
        const hasLegacySecrets = keys.some(
            (key) =>
                key === LegacyConfigMigration.LEGACY_API_KEY_KEY ||
                key.startsWith(LegacyConfigMigration.LEGACY_API_KEY_PREFIX)
        );

        return hasSingleBaseUrl || hasMultiBackend || hasLegacySecrets;
    }

    public async extractLegacyBackends(): Promise<LegacyBackendConfig[]> {
        const workspaceConfig = vscode.workspace.getConfiguration();
        const backends: LegacyBackendConfig[] = [];

        const multiBackendsRaw = workspaceConfig.get<unknown>(LegacyConfigMigration.LEGACY_BACKENDS_KEY);
        if (Array.isArray(multiBackendsRaw)) {
            for (const entry of multiBackendsRaw) {
                if (typeof entry !== "object" || entry === null) {
                    continue;
                }

                const backend = entry as LegacyBackendEntry;
                const baseUrl = typeof backend.baseUrl === "string" ? backend.baseUrl.trim() : "";
                if (!baseUrl) {
                    continue;
                }

                let apiKey: string | undefined;
                if (typeof backend.apiKeySecretRef === "string" && backend.apiKeySecretRef.length > 0) {
                    apiKey = await this.configManager.getSecret(backend.apiKeySecretRef);
                }

                if (!apiKey && typeof backend.id === "string" && backend.id.length > 0) {
                    apiKey = await this.configManager.getSecret(
                        `${LegacyConfigMigration.LEGACY_API_KEY_PREFIX}${backend.id}`
                    );
                }

                if (!apiKey && typeof backend.apiKey === "string" && backend.apiKey.trim().length > 0) {
                    apiKey = backend.apiKey.trim();
                }

                if (!apiKey) {
                    continue;
                }

                backends.push({
                    ...(typeof backend.id === "string" && { id: backend.id }),
                    ...(typeof backend.name === "string" && { name: backend.name }),
                    baseUrl,
                    apiKey,
                });
            }
        }

        if (backends.length === 0) {
            const singleBaseUrlRaw = workspaceConfig.get<string>(LegacyConfigMigration.LEGACY_BASE_URL_KEY, "");
            const singleBaseUrl = singleBaseUrlRaw?.trim() ?? "";
            if (singleBaseUrl) {
                const legacyKeysToTry = Array.from(
                    new Set([
                        LegacyConfigMigration.LEGACY_API_KEY_KEY,
                        LegacyConfigMigration.LEGACY_API_KEY_PREFIX.slice(0, -1),
                    ])
                );
                let apiKey: string | undefined;
                for (const key of legacyKeysToTry) {
                    if (!key) {
                        continue;
                    }
                    apiKey = await this.configManager.getSecret(key);
                    if (apiKey) {
                        break;
                    }
                }

                if (apiKey) {
                    backends.push({ baseUrl: singleBaseUrl, apiKey });
                }
            }
        }

        return backends;
    }

    public generateGroupNames(backends: LegacyBackendConfig[]): string[] {
        const names: string[] = [];
        let liteLLMCounter = 0;

        for (const backend of backends) {
            if (backend.name && backend.name.trim().length > 0) {
                names.push(backend.name);
                continue;
            }

            const label = liteLLMCounter === 0 ? "LiteLLM" : `LiteLLM ${liteLLMCounter}`;
            names.push(label);
            liteLLMCounter++;
        }

        return names;
    }

    public async executeMigration(): Promise<MigrationResult> {
        const errors: string[] = [];
        const groupNames: string[] = [];

        StructuredLogger.info("legacy.migration.started", {
            caller: "legacyConfigMigration",
        });

        const backends = await this.extractLegacyBackends();
        if (backends.length === 0) {
            StructuredLogger.info("legacy.migration.none_found", {
                note: "No legacy backends discovered",
            });
            await this.markMigrationCompleted();
            return {
                migrated: false,
                groupsCreated: 0,
                groupNames: [],
                cleanupComplete: false,
                errors: [],
            };
        }

        const names = this.generateGroupNames(backends);
        let groupsCreated = 0;

        for (let i = 0; i < backends.length; i++) {
            const backend = backends[i];
            const groupName = names[i];
            try {
                await vscode.commands.executeCommand("lm.migrateLanguageModelsProviderGroup", {
                    name: groupName,
                    vendor: "litellm-connector",
                    configuration: {
                        baseUrl: backend.baseUrl,
                        apiKey: backend.apiKey,
                    },
                });

                groupNames.push(groupName);
                groupsCreated++;

                StructuredLogger.info("legacy.migration.backend_migrated", {
                    groupName,
                    baseUrl: backend.baseUrl,
                });

                this.telemetryService?.captureLegacyConfigMigration({
                    backend_count: backends.length,
                    group_name: groupName,
                    source: backend.id ? "multi-backend" : "single-backend",
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const errorMsg = `Failed to migrate backend "${groupName}": ${message}`;
                errors.push(errorMsg);
                StructuredLogger.error("legacy.migration.backend_failed", {
                    groupName,
                    error: message,
                });
            }
        }

        let cleanupComplete = false;
        try {
            await this.cleanupLegacyConfig();
            cleanupComplete = true;
            StructuredLogger.info("legacy.migration.cleanup_completed", {});
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const errorMsg = `Failed to clean up legacy configuration: ${message}`;
            errors.push(errorMsg);
            StructuredLogger.error("legacy.migration.cleanup_failed", {
                error: message,
            });
        }

        await this.markMigrationCompleted();

        return {
            migrated: groupsCreated > 0,
            groupsCreated,
            groupNames,
            cleanupComplete,
            errors,
        };
    }

    private async cleanupLegacyConfig(): Promise<void> {
        const workspaceConfig = vscode.workspace.getConfiguration();
        const targets: vscode.ConfigurationTarget[] = [
            vscode.ConfigurationTarget.Global,
            vscode.ConfigurationTarget.Workspace,
            vscode.ConfigurationTarget.WorkspaceFolder,
        ];

        for (const target of targets) {
            await workspaceConfig.update(LegacyConfigMigration.LEGACY_BASE_URL_KEY, undefined, target);
            await workspaceConfig.update(LegacyConfigMigration.LEGACY_BACKENDS_KEY, undefined, target);
        }

        const keys = await this.context.secrets.keys();
        const legacyKeys = keys.filter(
            (key) =>
                key === LegacyConfigMigration.LEGACY_API_KEY_KEY ||
                key.startsWith(LegacyConfigMigration.LEGACY_API_KEY_PREFIX)
        );

        for (const key of legacyKeys) {
            await this.context.secrets.delete(key);
            StructuredLogger.debug("legacy.migration.secret_deleted", {
                key,
            });
        }
    }

    public async runMigrationIfNeeded(): Promise<MigrationResult | null> {
        if (await this.isMigrationCompleted()) {
            StructuredLogger.debug("legacy.migration.skipped", {
                reason: "already_completed",
            });
            return null;
        }

        if (!(await this.detectLegacyConfig())) {
            StructuredLogger.debug("legacy.migration.skipped", {
                reason: "no_legacy_config",
            });
            await this.markMigrationCompleted();
            return null;
        }

        StructuredLogger.info("legacy.migration.detected", {});

        const result = await this.executeMigration();

        if (result.migrated) {
            const message =
                result.groupsCreated === 1
                    ? "Migrated 1 LiteLLM backend to the new configuration system."
                    : `Migrated ${result.groupsCreated} LiteLLM backends to the new configuration system.`;
            const openLanguageModels = "Open Language Models";
            const choice = await vscode.window.showInformationMessage(message, openLanguageModels);
            if (choice === openLanguageModels) {
                try {
                    await vscode.commands.executeCommand("workbench.action.chat.manage");
                } catch {
                    await vscode.commands.executeCommand("workbench.action.openSettings", "@tag:language-model");
                }
            }
        }

        if (result.errors.length > 0) {
            this.telemetryService?.captureException(new Error("Migration completed with errors"), {
                caller: "legacyConfigMigration",
                level: "warning",
                properties: {
                    error_count: result.errors.length,
                },
            });
        }

        return result;
    }
}
