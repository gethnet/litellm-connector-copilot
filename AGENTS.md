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
- **Small, composable modules**: keep files focused; avoid monolithic logic. Limit any TypeScript file to no more than **1000 lines of code**. Break/split up larger files into smaller modular files or sub-modules before they exceed this threshold.
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
  - Wires the BackendRegistry's `onDidChange` event to VS Code's
    `onDidChangeLanguageModelChatInformation`
  - Message ingress pipeline (normalization, validation, filtering, trimming, error detection)
  - HTTP client interaction with endpoint routing
  - Telemetry and error handling
- **Derived classes** extend base and implement VS Code protocols:
  - `LiteLLMChatProvider`: Implements `LanguageModelChatProvider`, handles chat streaming specifics
  - `LiteLLMCompletionProvider`: Implements `LanguageModelTextCompletionProvider`, wraps prompts
  - Both delegate request building to base, eliminating duplication
- **Benefit**: Adding new provider types requires minimal code (protocol wrapper only)
- **BackendRegistry** (`LiteLLMProviderRegistry`): The single source of truth for backends and their associated models. Owns the discovery HTTP fetch, the per-group namespacing, the change detection, and the per-model capability caches. See "BackendRegistry contract" below.

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
- **Engine target**: `package.json` `engines.vscode` is `^1.120.0`. All provider code must assume the VS Code 1.120 Language Model API surface.
- **Configuration & Secrets (v1.120+, per-group configuration)**:
  - Language model provider configuration (base URL, API key, and any per-backend settings) is declared via the `languageModelChatProviders` contribution point in `package.json`
  - VS Code 1.120 supports **per-group configuration**: each configured provider group passes its own `options.configuration` into `provideLanguageModelChatInformation` and request methods. The provider must read configuration from `options.configuration` for every call rather than caching globally.
  - Configuration properties marked with `"secret": true` are encrypted by VS Code
  - Use `ConfigManager.convertProviderConfiguration()` to convert VS Code's per-group config object into the internal `LiteLLMConfig` format
  - For non-provider secrets: use `vscode.SecretStorage` via `ConfigManager`. **Never** use `globalState`.
- **Model picker visibility**: every `LanguageModelChatInformation` returned from `provideLanguageModelChatInformation` must set `isUserSelectable: true` so the model appears in VS Code's model picker dropdown. Models that omit this flag (or set it to `false`) are hidden from the picker even when discovery succeeds.
- **Backend grouping**: each `LanguageModelChatInformation` must set `category: { label, order }` — `label` is the user-visible group heading in the picker (typically the backend / group name), and `order` is the deterministic display order. Without this, models from multiple backends collapse into a single ungrouped list.
- **Reasoning effort picker (`group: "navigation"`)**: when a model supports reasoning, its `configurationSchema.properties.reasoningEffort` must include `group: "navigation"`. Only navigation-grouped properties are surfaced as inline picker actions in VS Code 1.120; without it the effort selector is hidden behind the secondary settings UI and users cannot change effort from the chat picker.

### Architecture & data flow (extension)

This extension integrates LiteLLM proxies into VS Code's Language Model APIs (chat and text completions).

**Current Provider Architecture Pattern (Shared Base + One Unified Chat Provider + Completions Provider)**:

The extension uses a **shared orchestration + specialized protocol handlers** pattern, with exactly **one** chat provider and one completions provider — no version-suffixed variants.

- **Base Orchestrator**: `src/providers/liteLLMProviderBase.ts`
  - Owns the shared request lifecycle used by provider implementations
  - Wires the BackendRegistry's `onDidChange` event to VS Code's
    `onDidChangeLanguageModelChatInformation` so the picker refreshes when
    a backend's model set actually changes
  - Runs the common ingress pipeline (normalization, validation, parameter filtering, trimming, error detection)
  - Delegates transport concerns to adapter/client layers
  - Centralizes telemetry, logging, and shared error handling

- **Chat Provider** (single, unified): `src/providers/liteLLMChatProvider.ts`
  - There is **one** chat provider class named `LiteLLMChatProvider`. Do **not** introduce or reintroduce version-suffixed siblings (`LiteLLMChatProviderV2`, `LiteLLMChatProviderV3`, etc.). The previous V1/V2/V3 split has been collapsed into this single implementation.
  - Implements `vscode.LanguageModelChatProvider` against the VS Code 1.120 surface
  - Extends `LiteLLMProviderBase` and adds chat-protocol behavior only
  - Handles chat-specific streaming, tool call buffering, response part emission (text / thinking / data / tool calls), and message parsing
  - Reads per-group configuration from `options.configuration` on each call (no global config caching)
  - Returns `LanguageModelChatInformation` entries with `isUserSelectable: true` so models appear in the picker
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
  - Activates extension and instantiates exactly one `LiteLLMChatProvider` and one `LiteLLMCompletionProvider`
  - Registers `LiteLLMChatProvider` with `vscode.lm.registerLanguageModelChatProvider("litellm-connector", provider)`
  - Registers `LiteLLMCompletionProvider` with `vscode.lm.registerLanguageModelTextCompletionProvider("litellm-connector", provider)`
  - Both providers share same `context.secrets` for `SecretStorage` (if needed for non-provider secrets)
  - Both receive per-group configuration from VS Code via `options.configuration` in `provideLanguageModelChatInformation` and request methods
  - Configuration schema defined in `package.json` `languageModelChatProviders` contribution point (VS Code 1.120 per-group format)

- **Adapters**:
  - `src/adapters/litellmClient.ts` — HTTP client and endpoint routing integration
  - `src/adapters/multiBackendClient.ts` — Multi-backend orchestrator and model namespacing
  - `src/adapters/responsesAdapter.ts` — LiteLLM `/responses` endpoint payload translation
  - `/responses` stream event handling (`output_item.delta`, `output_item.done`, anonymous tool buffering) lives in `src/adapters/streaming/liteLLMStreamInterpreter.ts`
  - `src/adapters/tokenUtils.ts` — token budgeting, trimming, and related helpers

- **Config**: `src/config/configManager.ts`
  - Handles per-group provider configuration from `options.configuration` (Base URL, API Key, and any group-scoped settings supplied by VS Code 1.120)
  - Also manages workspace settings via `vscode.workspace.getConfiguration()` (model overrides, caching, etc.)
  - `convertProviderConfiguration()` converts the per-group VS Code provider config into the internal `LiteLLMConfig` format

- **Legacy Config Migration**: `src/config/legacyConfigMigration.ts`
  - Detects leftover `litellm-connector.baseUrl` / `backends` workspace settings and `SecretStorage` keys from pre-2.1.0 installs
  - Runs once on activation and presents a guided notification to migrate old config into the VS Code provider-group format
  - Migration state is persisted in `globalState` so the prompt only fires once per install

**Key Design Principle**: There is exactly one chat provider and one completions provider. Both reuse the same message ingress pipeline in the base orchestrator. This eliminates code duplication, ensures consistent behavior, and avoids the version-suffixed provider sprawl that previously existed.

**Structural rule of thumb**: shared cross-provider behavior belongs in the base class or adapters; VS Code protocol specifics belong in the single derived provider that owns that protocol. Do not fork chat-protocol logic into version-suffixed siblings.

When architecture changes, update this section in the same change so the document remains a reliable map of the codebase.

#### BackendRegistry contract (`src/providers/litellmProviderRegistry.ts`)

The `BackendRegistry` (class `LiteLLMProviderRegistry`) is the **single
source of truth for backends and their associated models**. It owns the
discovery HTTP fetch, the per-group namespacing, the change detection, and
the per-model capability caches.

The contract is **public read, internal write**:

- **Public surface (read + ingress)**:
  - `discoverModels(options, token)` — the only way for VS Code (or any
    consumer) to fetch a model list and populate the registry. The
    registry owns the HTTP fetch, the namespacing (`<routing>/<rawModel>`
    ids), and the change detection; consumers see a single ingress that
    returns the model list, updates the registry, and fires the change
    event as a unit.
  - `lookup(id)` — resolve a namespaced id to its routing entry
    (`{baseUrl, apiKey, rawModelName, routingIdentity}`). The response
    path uses this as the fallback when VS Code does not pass the
    per-group BYOK config on the call.
  - `findBackendForRawName(name)` — workspace-override routing lookup.
  - `extractRawName(id)` — strip the routing prefix from a namespaced id.
  - `getModelInfo(id)` / `getDerivedCapabilities(id)` — read the
    per-model capability caches populated during discovery. These are
    NOT a model-list cache — they cache the capability info for known
    models and feed the request hot path.
  - `size()`, `clear()`, `clearCaches()` — registration-state reads
    and reset. `clear()` wipes the routing table (user-initiated
    reload); `clearCaches()` wipes the capability caches and the
    backoff controller.
  - `onDidChange` — fires when a backend's model set has actually
    changed. The base provider subscribes once and forwards to VS
    Code's `onDidChangeLanguageModelChatInformation`.

- **Internal surface (write — NOT part of the public contract)**:
  - `setModelsForBackend(...)`, `getModelsForBackend(baseUrl)`,
    `getModelIdsForBackend(baseUrl)` — internal write/read, used only
    by `discoverModels` itself for change detection. They are
    TypeScript `private` and MUST NOT be called from outside the
    class. Tests that need to seed a known (id → backend) mapping
    cast via `unknown` to a typed test seam.

**Why merge discovery into the registry?** The previous design kept
`ModelDiscovery` as a separate class and the registry as a pure data
structure. The base provider had to call `modelDiscovery.discover(...)`,
then `registry.setModelsForBackend`, then check
`registry.getModelIdsForBackend` for change detection — a three-step
orchestration that was easy to get wrong (write-before-compare silently
broke change detection). With the merge, `discoverModels` is the only
call site that needs to know the write protocol exists, and consumers
see a single ingress.

**Stateless by design**: there is no model-list cache, no in-flight
de-duplication, and no TTL. Every `discoverModels` call is a single
HTTP round-trip. The "ghost cache" is gone, and the picker always
reflects the live state of the backend.

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

#### Configuration Flow (v1.120+, per-group)
Configuration from user settings reaches providers via VS Code's language model API on a per-group basis:
1. User configures Base URL, API Key, and any other declared properties for a provider group in the language model provider settings UI
2. VS Code encrypts secrets (fields marked `"secret": true` in `package.json`)
3. VS Code passes the per-group configuration to the provider via `options.configuration` on every `provideLanguageModelChatInformation` and request method invocation
4. `ConfigManager.convertProviderConfiguration()` converts the per-group object to internal `LiteLLMConfig` format
5. Base orchestrator uses that config for model discovery, HTTP client setup, etc., scoped to the originating group
6. Workspace-level settings (model overrides, caching preferences) retrieved via `vscode.workspace.getConfiguration()`

Provider code must not assume a single global configuration — multiple groups may be active simultaneously and each call must use its own `options.configuration`.

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
- **VS Code 1.120+** (declared in `package.json` `engines.vscode` as `^1.120.0`): required for:
  - `languageModelChatProviders` contribution point with **per-group configuration** schema
  - Stable `LanguageModelChatProvider` API used by the unified `LiteLLMChatProvider`
  - `LanguageModelTextCompletionProvider` proposed API (completions provider)
  - `isUserSelectable` flag on `LanguageModelChatInformation` for model picker visibility
  - Proper secrets encryption for provider configuration

## 5) Change workflow (agent/CI)

### Commands (permitted only)
- `npm run clean` — Clean build artifacts
- `npm run compile` — TypeScript typecheck/build validation
- `npm run lint` — ESLint checks
- `npm run lint:fix` — ESLint checks with autofix
- `npm run format` — Prettier formatting check
- `npm run format:fix` — Prettier formatting with fix
- `npm run test:coverage` — Unit tests with coverage report (use this for testing)
- `npm run bump-version patch|minor|dev` — Version bumps

> ⚠️ **DO NOT use `npm run test`**, `npm run check`, or any other npm scripts — they may cause issues. Only run the commands listed above.

### When to run what
- Before implementing non-trivial logic: add or update the relevant tests first.
- Before/after non-trivial edits: run `npm run compile` and `npm run test:coverage`.
- Before finishing the task: verify the changed files contain the intended code or that new files exist with the expected contents.
- Before finishing the tasks run: run `npm run lint` → `npm run format` → `npm run test:coverage` independently (verify each succeeds)
- Before opening/updating a PR: run `npm run lint` → `npm run format` → `npm run test:coverage` independently (verify each succeeds)

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
- [ ] Configuration handling respects VS Code v1.120+ per-group provider config system
  - Provider secrets handled via `languageModelChatProviders.configuration` in `package.json`
  - Per-group `options.configuration` is read on every provider call (no global config caching)
  - Workspace settings retrieved via `vscode.workspace.getConfiguration()`
  - Use `ConfigManager.convertProviderConfiguration()` to unify config sources
- [ ] All `LanguageModelChatInformation` entries returned from `provideLanguageModelChatInformation` set `isUserSelectable: true` so they appear in the VS Code model picker
- [ ] Telemetry includes `caller` context to distinguish invocation source ("inline-completions", "terminal-chat", etc.)
- [ ] Model discovery tested for correctness and performance via the BackendRegistry (shared across all providers)
