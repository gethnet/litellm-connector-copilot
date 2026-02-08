# Copilot Instructions for LiteLLM Connector for Copilot

Project context and guidelines for AI coding agents working on the `litellm-connector-copilot` extension.

## 🏗 Architecture & Data Flow

This extension integrates LiteLLM proxies into VS Code's Language Model Chat API.

- **Entry Point**: `src/extension.ts` - Activates the extension and registers the `litellm-connector` provider.
- **Provider**: `src/providers/liteLLMProvider.ts` - Implements `vscode.LanguageModelChatProvider`. It handles model discovery via `/model/info`, iterates over request parts (including vision data), and manages streaming state.
- **Adapters**:
  - `src/adapters/litellmClient.ts`: Low-level HTTP client for `/chat/completions`.
  - `src/adapters/responsesClient.ts` & `src/adapters/responsesAdapter.ts`: Handles LiteLLM's specialized `/responses` endpoint.
- **Config**: `src/config/configManager.ts` - Manages user settings (Base URL, API Key) using `vscode.SecretStorage`.
- **Token Management**: `src/adapters/tokenUtils.ts` - Handles message trimming and budget calculations.

### Key Logic
- **File & Reference Handling**: The provider converts `vscode.LanguageModelChatRequest` content parts. It specifically handles `LanguageModelTextPart` for prompts and `LanguageModelBinaryPart` for vision support (converting images to base64 for OpenAI-compatible payloads).
- **Parameter Filtering**: `KNOWN_PARAMETER_LIMITATIONS` in `liteLLMProvider.ts` strips unsupported parameters (like `temperature` for O1 models).
- **Streaming & Buffering**: The provider manages complex streaming states, including buffering tool calls to handle partial SSE chunks.

## 🛠 Developer Workflows

- **Local Development**: Press `F5` to start "Extension Development Host".
- **Quality Assurance**: Before submitting changes, ensure the following commands pass:
  - `npm run lint`: Runs ESLint with auto-fix.
  - `npm run format`: Formats code using Prettier.
  - `npm run compile`: Validates TypeScript compilation.
- **Testing**:
  - Unit tests: `npm run test` (runs in `xvfb` on Linux).
  - Coverage: `npm run test:coverage` - Generates reports in `coverage/`.
- **API Updates**: `npm run download-api` fetches the latest `vscode.d.ts`.

## 📏 Standards & Patterns

- **Modularity**: Avoid monolithic files. Logic for transformation, parsing, or complex utilities should be moved out of providers and into dedicated files (e.g., `src/utils/` or `src/adapters/`).
- **VS Code API**: Always target the `vscode` namespace. Use `@vscode/dts` for proposed APIs in `src/vscode.d.ts`.
- **Secrets**: Use `ConfigManager` (wraps `context.secrets`) for API keys. NEVER use `globalState`.
- **Model IDs**: The provider caches `LiteLLMModelInfo` to determine capabilities (vision, tools).
- **Tool Calling**: Supports standard OpenAI tool calling and LiteLLM's `responses` format. Check `litellmClient.ts` for transformation logic.
- **Logging & Telemetry**: Every major function entry, critical decision point, and error must be logged via `Logger`. Performance metrics and request outcomes must be tracked using `LiteLLMTelemetry`. Use `Logger.debug` for execution flow and `Logger.error` for failures.

## 🔗 External Dependencies
- **LiteLLM**: The extension expects a compatible OpenAI-like proxy.
- **GitHub Copilot Chat**: This extension is a *provider* for the official Copilot Chat extension. It will not function without it.
