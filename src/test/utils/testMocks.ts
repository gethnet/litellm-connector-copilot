import * as vscode from "vscode";

export const TEST_USER_AGENT = "GitHubCopilotChat/test VSCode/test";

/**
 * Creates a mock vscode.SecretStorage for tests.
 *
 * @param entries - Optional key/value map. Defaults to `{ baseUrl, apiKey }`.
 *   Pass a Map or plain object to supply arbitrary secret keys.
 * @param baseUrl - Shorthand when using default entries (ignored if entries provided).
 * @param apiKey  - Shorthand when using default entries (ignored if entries provided).
 */
export function createMockSecrets(
    entries?: Record<string, string> | Map<string, string>,
    baseUrl = "http://localhost:4000",
    apiKey = "test-key"
): vscode.SecretStorage {
    const map: Map<string, string> = entries
        ? entries instanceof Map
            ? entries
            : new Map(Object.entries(entries))
        : new Map([
              ["baseUrl", baseUrl],
              ["apiKey", apiKey],
          ]);

    return {
        get: async (key: string) => map.get(key),
        store: async (key: string, value: string) => {
            map.set(key, value);
        },
        delete: async (key: string) => {
            map.delete(key);
        },
        keys: async () => [...map.keys()],
        onDidChange: (listener: (e: vscode.SecretStorageChangeEvent) => void) => {
            return new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event(listener);
        },
    } as unknown as vscode.SecretStorage;
}

export function createMockModel(
    overrides: Partial<vscode.LanguageModelChatInformation> = {}
): vscode.LanguageModelChatInformation {
    return {
        id: "gpt-4o",
        family: "gpt-4o",
        name: "GPT-4o",
        maxInputTokens: 128000,
        ...overrides,
    } as vscode.LanguageModelChatInformation;
}

/**
 * Creates a mock vscode.LogOutputChannel for tests.
 * All logging methods are no-ops. Useful when stubbing `vscode.window.createOutputChannel`.
 */
export function createMockOutputChannel(): vscode.LogOutputChannel {
    return {
        name: "mock",
        log: () => {},
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        show: () => {},
        hide: () => {},
        clear: () => {},
        dispose: () => {},
        append: () => {},
        appendLine: () => {},
        replace: () => {},
    } as unknown as vscode.LogOutputChannel;
}
