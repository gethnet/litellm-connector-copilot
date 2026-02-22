import * as vscode from "vscode";

export const TEST_USER_AGENT = "GitHubCopilotChat/test VSCode/test";

export function createMockSecrets(baseUrl = "http://localhost:4000", apiKey = "test-key"): vscode.SecretStorage {
    return {
        get: async (key: string) => (key === "baseUrl" ? baseUrl : apiKey),
        store: async () => {},
        delete: async () => {},
        keys: async () => ["baseUrl", "apiKey"],
        onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
    };
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
