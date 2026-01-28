# Copilot Instructions for LiteLLM Connector for Copilot

Project context and guidelines for AI coding agents working on the `litellm-connector-copilot` extension.

## 🏗 Architecture & Data Flow

This extension integrates LiteLLM proxies into VS Code's Language Model Chat API.

- **Entry Point**: `src/extension.ts` - Activates the extension and registers the `litellm-connector` provider.
- **Provider**: `src/providers/liteLLMProvider.ts` - Implements `vscode.LanguageModelChatProvider`. It handles model discovery via `/model/info` and coordinates the chat lifecycle.
- **Adapter**: `src/adapters/litellmClient.ts` - Low-level HTTP client for interacting with LiteLLM endpoints (`/chat/completions` or `/responses`).
- **Config**: `src/config/configManager.ts` - Manages user settings (Base URL, API Key) using `vscode.SecretStorage` for security.
- **Token Management**: `src/adapters/tokenUtils.ts` - Handles message trimming and budget calculations to fit model context windows.

### Key Logic
- **Parameter Filtering**: `KNOWN_PARAMETER_LIMITATIONS` in `liteLLMProvider.ts` tracks which models don't support specific OpenAI parameters (like `temperature` for O1 models).
- **Streaming**: The provider parses SSE (Server-Sent Events) from LiteLLM and maps them to `vscode.LanguageModelResponsePart` (text or tool calls).

## 🛠 Developer Workflows

- **Local Development**: Press `F5` to start "Extension Development Host".
- **API Updates**: `npm run download-api` fetches the latest `vscode.d.ts` for the Language Model API.
- **Testing**:
  - Unit tests: `npm run test` (runs in `xvfb` on Linux).
  - Coverage: `npm run test:coverage` - Generates HTML and LCOV reports in `coverage/`.
- **Versioning**: Use `npm run bump-version` to update `package.json` version.

## 📏 Standards & Patterns

- **VS Code API**: Always target the `vscode` namespace. Note that we use `@vscode/dts` to access proposed or newer APIs (stored in `src/vscode.d.ts`).
- **Secrets**: NEVER use `workspaceState` or `globalState` for API keys. Use `ConfigManager` which wraps `context.secrets`.
- **Model IDs**: LiteLLM model IDs are treated as keys. The provider caches `LiteLLMModelInfo` to determine capabilities (vision, tools).
- **Tool Calling**: We support both standard OpenAI tool calling and LiteLLM's `responses` format. Check `litellmClient.ts` for transformation logic.

## 🔗 External Dependencies
- **LiteLLM**: The extension expects a compatible OpenAI-like proxy.
- **GitHub Copilot Chat**: This extension is a *provider* for the official Copilot Chat extension. It will not function without it.
