# AGENTS.md — Engineering Standards for Automated Coding Agents

This document defines **repo-wide, tool-agnostic** expectations for automated coding agents contributing to `litellm-connector-copilot`.

> This is the single source of truth for agent behavior. Tool-specific instruction files (e.g. `.github/copilot-instructions.md`) should **reference** this file and avoid duplicating it.

## 1) Non‑negotiables

### Code quality bar
- **TDD first**: write or update the test that proves the behavior before implementing the production change. Follow a red → green → refactor loop whenever the task is more than a trivial text edit.
- **Elegant, clean, readable at a glance**: prefer simple, explicit code over cleverness.
- **KISS by default**: choose the simplest design that satisfies the requirement and is easy to verify.
- **DRY by design**: centralize shared logic, constants, and helpers instead of duplicating behavior across modules.
- **No black boxes**: if something “just works”, document *why* (assumptions, invariants, and failure modes).
- **Reusable by default**: extract pure helpers and shared utilities; avoid copy/paste.
- **Small, composable modules**: keep files focused; avoid monolithic logic.
- **Logical file placement**: place new code in the most specific folder that owns the responsibility; prefer extending an existing module before creating a parallel one with overlapping behavior.
- **Consistent style**: match existing patterns (TypeScript, ESLint/Prettier).
- **Well documented code**: add clear comments where behavior is non-obvious so the next reader understands expectations, invariants, and failure modes without reverse engineering the logic.

### Architecture principles
- Prefer **small, hierarchical modules** with one clear responsibility each.
- Prefer **pure transformations** (input → output) separated from side effects (I/O, VS Code APIs, HTTP).
- Keep orchestration thin and move shaping/parsing/normalization into dedicated adapters or utilities.
- Avoid duplicate branches of logic when a shared helper, adapter, or base-class method can express the behavior once.
- Push protocol/payload shaping/parsing into **adapters**; keep orchestration layers thin.
- Centralize cross-cutting concerns:
  - logging
  - telemetry
  - model capability logic
  - token budgeting/trimming

## 2) Testing & coverage policy

### TDD workflow
- Start with a failing test or update an existing test to capture the desired behavior before changing implementation code.
- Keep tests small, deterministic, and named after the behavior they protect.
- After the test fails for the expected reason, implement the smallest change that makes it pass.
- Refactor only after the test suite is green, preserving behavior while improving readability and reuse.
- If a task truly cannot be driven by an automated test, document why and add the strongest feasible validation instead.

### Coverage targets (tracked)
- **Statements / Branches / Functions:** strive for **90%+**
- **Lines:** strive for **85%+**

### Minimums (do not regress)
- **Lines:** **85%+** minimum
- **No category should drop by more than 1%** (Statements, Branches, Functions, Lines)

### Test standards
- Tests must be **explanatory**: intent is obvious from the name and structure.
- Tests must be **clean and well documented**: prefer clarity in setup/act/assert.
- Prefer **small, focused unit tests** with deterministic inputs.
- When fixing bugs, add a **regression test** that fails before the fix, then implement the fix.
- Tests must not use or target `any` as an item or constraint.  `any` leads to confusion
  and blackbox type code.

## 3) Repo conventions

### Communication artifacts (commit messages, PRs, issues, changelogs)
- **Be clear and concise**: state *what* changed and *why* in as few words as possible.
- **Use emojis for visual scanning**: include 1–2 relevant emojis at the start of titles (commit/PR/issue) to improve readability.
  - Examples: `🛠️ Fix tool-call id normalization`, `🧼 Sanitize provider error logs`, `🚀 Release v1.3.x`.
- **Prefer outcome-focused wording**: describe user impact (e.g. “prevents hard failure”, “reduces false redactions”).
- **Avoid noise**: no walls of text; prefer short summaries and bullet points for PR descriptions and changelog entries.

### File structure guidance
Group by responsibility and keep folder placement intuitive to a first-time reader:
- `src/providers/`: Language Model provider implementations
  - `liteLLMProviderBase.ts` — Shared orchestration base class
  - `liteLLMChatProvider.ts` — Chat API provider (extends base)
  - `liteLLMCompletionProvider.ts` — Completions API provider (extends base)
  - `index.ts` — Provider exports
- `src/adapters/`: HTTP clients, payload shaping, endpoint-specific parsing
- `src/utils/`: shared utilities (logging, telemetry, model helpers)
- `src/config/`: configuration and secrets
- `src/commands/`: command registrations and UI entry points
- `src/**/test/`: unit tests co-located with the module under test
- `src/test/`: integration tests and shared test utilities
  - `integration/` — end-to-end and cross-module tests
  - `utils/` — shared mocks and test helpers

Prefer names that convey intent (`*Client`, `*Adapter`, `*Utils`, `*Provider`).
Prefer adding code beside related behavior instead of creating broad utility dumping grounds.
When introducing a new folder or module, make the ownership boundary obvious from the name.

**Provider Architecture Pattern**:
- **Base class** (`LiteLLMProviderBase`): Handles ALL orchestration logic
  - Model discovery and caching
  - Message ingress pipeline (normalization, validation, filtering, trimming, error detection)
  - HTTP client interaction with endpoint routing
  - Telemetry and error handling
- **Derived classes** extend base and implement VS Code protocols:
  - `LiteLLMChatProvider`: Implements `LanguageModelChatProvider`, handles chat streaming specifics
  - `LiteLLMCompletionProvider`: Implements `LanguageModelTextCompletionProvider`, wraps prompts
  - Both delegate request building to base, eliminating duplication
- **Benefit**: Adding new provider types requires minimal code (protocol wrapper only)

### Secrets
- Store API keys only via `ConfigManager` / `SecretStorage`.
- **Never** store secrets in `globalState`.

### Documentation and comments
- Document the expectation of non-obvious code blocks, especially around request shaping, streaming, retries, trimming, and error handling.
- Comments should explain **why** the code exists, the assumptions it relies on, and what must remain true.
- Avoid redundant comments that simply restate the code; use comments to reduce ambiguity, not add noise.

### Keep architecture notes current
- If a file is renamed or responsibility moves, update architecture notes/docs in the same change.
- Prefer pointing at the exact module that owns the behavior (single source of truth).

## 4) VS Code extension specifics

This repository is a **VS Code extension**. Agents must follow these rules when changing extension code.

- **VS Code API**: Always target the `vscode` namespace.
- **Proposed APIs**: Use `@vscode/dts` and keep `src/vscode.d.ts` current when relying on proposed types.
- **Configuration & Secrets (v1.109+)**:
  - Language model provider configuration (base URL, API key) is managed through `languageModelChatProviders` contribution point in `package.json`
  - Configuration properties marked with `"secret": true` are encrypted by VS Code
  - Providers receive configuration via `options.configuration` in request methods
  - Use `ConfigManager.convertProviderConfiguration()` to convert VS Code config to internal format
  - For other secrets: Use `vscode.SecretStorage` via `ConfigManager` for non-provider secrets. **Never** use `globalState`.

### Architecture & data flow (extension)

This extension integrates LiteLLM proxies into VS Code's Language Model APIs (chat and text completions).

**Current Provider Architecture Pattern (Shared Base + Specialized Providers)**:

The extension uses a **shared orchestration + specialized protocol handlers** pattern:

- **Base Orchestrator**: `src/providers/liteLLMProviderBase.ts`
  - Owns the shared request lifecycle used by provider implementations
  - Centralizes model discovery, caching, and shared validation
  - Runs the common ingress pipeline (normalization, validation, parameter filtering, trimming, error detection)
  - Delegates transport concerns to adapter/client layers
  - Centralizes telemetry, logging, and shared error handling

- **Chat Provider**: `src/providers/liteLLMChatProvider.ts`
  - Implements `vscode.LanguageModelChatProvider`
  - Extends `LiteLLMProviderBase` and adds chat-protocol behavior only
  - Handles chat-specific streaming, tool call buffering, response parts, and message parsing
  - Reuses the base request pipeline for normalization, filtering, trimming, and routing

- **Completions Provider**: `src/providers/liteLLMCompletionProvider.ts`
  - Implements `vscode.LanguageModelTextCompletionProvider`
  - Extends `LiteLLMProviderBase` and adds completion-specific protocol wrapping only
  - Converts prompt input into request messages that the shared pipeline can process
  - Extracts completion text from streamed or buffered responses
  - Reuses base logic for validation, parameter filtering, token management, routing, and error handling

- **Commit / auxiliary providers**: keep any specialized provider thin and protocol-focused
  - Reuse the shared base lifecycle whenever the provider still targets LiteLLM-backed request orchestration
  - Avoid re-implementing shared request preparation, endpoint selection, or quota/error logic in derived providers

- **Entry Point**: `src/extension.ts`
  - Activates extension and instantiates both providers
  - Registers `LiteLLMChatProvider` with `vscode.lm.registerLanguageModelChatProvider("litellm-connector", provider)`
  - Registers `LiteLLMCompletionProvider` with `vscode.lm.registerLanguageModelTextCompletionProvider("litellm-connector", provider)`
  - Both providers share same `context.secrets` for `SecretStorage` (if needed for non-provider secrets)
  - Both receive configuration from VS Code via `options.configuration` in request methods
  - Configuration schema defined in `package.json` `languageModelChatProviders` contribution point

- **Adapters**:
  - `src/adapters/litellmClient.ts` — HTTP client and endpoint routing integration
  - `src/adapters/responsesClient.ts` & `src/adapters/responsesAdapter.ts` — LiteLLM `/responses` endpoint support and payload translation
  - `src/adapters/tokenUtils.ts` — token budgeting, trimming, and related helpers

- **Config**: `src/config/configManager.ts`
  - Handles provider configuration from `options.configuration` (Base URL, API Key from VS Code)
  - Also manages workspace settings via `vscode.workspace.getConfiguration()` (model overrides, caching, etc.)
  - `convertProviderConfiguration()` converts VS Code provider config to internal `LiteLLMConfig` format
  - Legacy migration support from `vscode.SecretStorage` for users upgrading from pre-1.109 versions

**Key Design Principle**: Both chat and completions providers reuse the same message ingress pipeline. This eliminates code duplication, ensures consistent behavior, and makes the architecture extensible for future provider types.

**Structural rule of thumb**: shared cross-provider behavior belongs in the base class or adapters; VS Code protocol specifics belong in the derived provider that owns that protocol.

When architecture changes, update this section in the same change so the document remains a reliable map of the codebase.

### Key logic (extension)

#### Shared Message Ingress Pipeline (Base Orchestrator)
All incoming requests (chat or completions) flow through this pipeline:

1. **Normalize**: Convert to `OpenAIChatCompletionRequest` format
   - Chat: messages already in correct format
   - Completions: wrap prompt string as user message
2. **Validate**: Get model info, check if model exists and is configured
3. **Filter Parameters**: Strip unsupported params via `KNOWN_PARAMETER_LIMITATIONS`
4. **Trim**: Ensure messages fit within `model.maxInputTokens` budget
5. **Detect Errors**: Check for quota failures, apply tool redaction if needed
6. **Route**: Send to appropriate endpoint via `LiteLLMClient.getEndpoint()`
7. **Process Response**: Extract completion text or stream response parts

Keep this pipeline shared unless the change is intentionally protocol-specific and cannot be expressed in the common path.

#### Chat-Specific Logic (Chat Provider)
- **Request part conversion**: handle `LanguageModelTextPart` and `LanguageModelBinaryPart` (vision); images must be encoded for OpenAI-compatible payloads
- **Streaming state management**: buffer partial tool calls when SSE frames arrive fragmented
- **Response emission**: emit `LanguageModelResponsePart`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart` to progress callback
- **Tool call parsing**: extract and validate tool calls from streaming chunks

#### Completions-Specific Logic (Completions Provider)
- **Prompt wrapping**: convert simple `string` prompt to `LanguageModelChatRequestMessage` for base pipeline
- **Stream text extraction**: parse SSE chunks and accumulate completion text
- **Model selection**: resolve model using `modelIdOverride` config or first available model with `inline-completions` tag

#### Configuration Flow (v1.109+)
Configuration from user settings reaches providers via VS Code's language model API:
1. User configures Base URL and API Key in language model provider settings UI
2. VS Code encrypts secrets (fields marked `"secret": true` in package.json)
3. VS Code passes configuration to provider via `options.configuration` in request methods
4. `ConfigManager.convertProviderConfiguration()` converts to internal `LiteLLMConfig` format
5. Base orchestrator uses config for model discovery, HTTP client setup, etc.
6. Workspace-level settings (model overrides, caching preferences) retrieved via `vscode.workspace.getConfiguration()`

#### Endpoint Agnosticism
The ingress pipeline is agnostic to endpoint choice:
- `LiteLLMClient.getEndpoint()` decides routing based on model info and endpoint availability
- Request building happens once in base, regardless of endpoint choice
- Responses parsed uniformly (SSE format compatible across endpoint types)
- Both chat and completions use same routing logic transparently
- **Benefit**: `/responses` endpoint support benefits both chat and completions automatically

### External dependencies
- **LiteLLM**: expects a compatible OpenAI-like proxy with `/chat/completions`, `/completions`, and/or `/responses` endpoints
- **GitHub Copilot Chat**: this extension is a *provider* for the official Copilot Chat extension (chat provider)
- **VS Code 1.109+**: required for:
  - `languageModelChatProviders` contribution point and provider configuration schema
  - `LanguageModelTextCompletionProvider` proposed API (completions provider)
  - Proper secrets encryption for provider configuration

## 5) Change workflow (agent/CI)

### Commands
- `npm run lint` — ESLint checks (may apply autofixes depending on config)
- `npm run format` — Prettier formatting
- `npm run compile` — TypeScript typecheck/build validation
- `npm run test` — Unit tests
- `npm run test:coverage` — Unit tests with coverage report (prefer this)

### When to run what
- Before implementing non-trivial logic: add or update the relevant tests first.
- Before/after non-trivial edits: run `npm run compile` and `npm run test:coverage`.
- Before finishing the task: verify the changed files contain the intended code or that new files exist with the expected contents.
- Before finishing the tasks run: `npm run lint`, `npm run format`, and `npm run test:coverage`
- Before opening/updating a PR: run `npm run lint`, `npm run format`, `npm run test:coverage`.

### Validation requirements
- Do not assume an edit succeeded. Confirm the change by inspecting the file contents or verifying the new file exists on disk with the expected content.
- Validate both behavior and implementation presence: passing tests alone are not enough if the requested file edits did not land.
- When reporting completion, ensure the repository state reflects the requested changes and the final file contents match the intended outcome.

## 6) Updating existing code

Any code you edit must be brought up to these standards:
- write or update the test first whenever the task changes behavior
- simplify and clarify while touching it
- keep the design KISS and remove duplication while preserving readability
- improve module placement if the touched code is in the wrong logical home and the move is justified
- add comments that explain expectations or invariants where the logic is not obvious
- add/adjust tests to cover new and existing behavior
- ensure coverage does not regress beyond the allowed threshold

## 7) Definition of done (agent checklist)
- [ ] Relevant tests were written or updated before implementation for behavior changes.
- [ ] Code is readable at a glance; no unnecessary complexity.
- [ ] Code follows KISS and DRY; duplication has been removed or consciously justified.
- [ ] New logic is modular and reused where appropriate.
- [ ] Files and folders reflect clear ownership and logical placement.
- [ ] Logging added at major function entry/exit and critical decisions (where applicable).
- [ ] Telemetry updated for request outcomes and performance (where applicable).
- [ ] Comments/documentation explain non-obvious expectations, assumptions, and failure modes.
- [ ] Tests added/updated; intent is clear from test names.
- [ ] Coverage meets targets and does not regress > 1% in any category.
- [ ] Changed files were re-read or otherwise verified to confirm the requested code exists in the repository state.
- [ ] No secrets stored outside `ConfigManager` / `SecretStorage`.

### Provider-specific requirements (if working on `src/providers/`)
- [ ] Base class changes benefit all derived providers automatically (shared orchestration)
- [ ] Protocol-specific code stays in derived classes only (chat protocol, completions protocol, etc.)
- [ ] Shared request pipeline (message normalization, parameter filtering, token trimming) unchanged unless fixing a bug that affects all providers
- [ ] Both chat and completions providers tested for any base class changes
- [ ] New provider types extend base and reuse pipeline (no duplication of request processing or endpoint-specific logic)
- [ ] Configuration handling respects VS Code v1.109+ provider config system
  - Provider secrets handled via `languageModelChatProviders.configuration` in package.json
  - Workspace settings retrieved via `vscode.workspace.getConfiguration()`
  - Use `ConfigManager.convertProviderConfiguration()` to unify config sources
- [ ] Telemetry includes `caller` context to distinguish invocation source ("inline-completions", "terminal-chat", etc.)
- [ ] Model discovery and caching tested for correctness and performance (shared across all providers)
