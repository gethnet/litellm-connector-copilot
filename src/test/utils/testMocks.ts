import * as vscode from "vscode";

export const TEST_USER_AGENT = "GitHubCopilotChat/test VSCode/test";

/**
 * Shared no-op helper for mock methods that intentionally do nothing.
 * Centralized so callers can reuse a single deliberate no-op reference.
 */
export function noop(): void {}

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
        log: noop,
        trace: noop,
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        show: noop,
        hide: noop,
        clear: noop,
        dispose: noop,
        append: noop,
        appendLine: noop,
        replace: noop,
    } as unknown as vscode.LogOutputChannel;
}

/**
 * Creates a mock vscode.Memento (suitable for `globalState` and `workspaceState`)
 * backed by an in-memory Map. Tests pass a seed object to pre-populate state.
 */
export function createMockMemento(seed?: Record<string, unknown>): vscode.Memento {
    const store = new Map<string, unknown>(Object.entries(seed ?? {}));
    return {
        get: <T>(key: string, defaultValue?: T): T | undefined => {
            if (store.has(key)) {
                return store.get(key) as T;
            }
            return defaultValue;
        },
        update: async (key: string, value: unknown) => {
            store.set(key, value);
        },
        keys: () => [...store.keys()],
    } as vscode.Memento;
}
