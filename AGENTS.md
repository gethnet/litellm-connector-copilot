# AGENTS.md — Engineering Standards for Automated Coding Agents

This document defines **repo-wide, tool-agnostic** expectations for automated coding agents contributing to `litellm-connector-copilot`.

> This is the single source of truth for agent behavior. Tool-specific instruction files (e.g. `.github/copilot-instructions.md`) should **reference** this file and avoid duplicating it.

## 1) Non‑negotiables

### Code quality bar
- **Elegant, clean, readable at a glance**: prefer simple, explicit code over cleverness.
- **No black boxes**: if something “just works”, document *why* (assumptions, invariants, and failure modes).
- **Reusable by default**: extract pure helpers and shared utilities; avoid copy/paste.
- **Small, composable modules**: keep files focused; avoid monolithic logic.
- **Consistent style**: match existing patterns (TypeScript, ESLint/Prettier).

### Architecture principles
- Prefer **pure transformations** (input → output) separated from side effects (I/O, VS Code APIs, HTTP).
- Push protocol/payload shaping/parsing into **adapters**; keep orchestration layers thin.
- Centralize cross-cutting concerns:
  - logging
  - telemetry
  - model capability logic
  - token budgeting/trimming

## 2) Testing & coverage policy

### Coverage targets (tracked)
- **Statements / Branches / Functions:** strive for **90%+**
- **Lines:** strive for **85%+**

### Minimums (do not regress)
- **Lines:** **80%+** minimum
- **No category should drop by more than 1%** (Statements, Branches, Functions, Lines)

### Test standards
- Tests must be **explanatory**: intent is obvious from the name and structure.
- Tests must be **clean and well documented**: prefer clarity in setup/act/assert.
- Prefer **small, focused unit tests** with deterministic inputs.
- When fixing bugs, add a **regression test** that fails before the fix.

## 3) Repo conventions

### File structure guidance
Group by responsibility:
- `src/providers/`: orchestration, request/response streaming state
- `src/adapters/`: HTTP clients, payload shaping, endpoint-specific parsing
- `src/utils/`: shared utilities (logging, telemetry, model helpers)
- `src/config/`: configuration and secrets
- `src/commands/`: command registrations and UI entry points
- `src/test/`: tests grouped by module under test

Prefer names that convey intent (`*Client`, `*Adapter`, `*Utils`, `*Provider`).

### Secrets
- Store API keys only via `ConfigManager` / `SecretStorage`.
- **Never** store secrets in `globalState`.

### Keep architecture notes current
- If a file is renamed or responsibility moves, update architecture notes/docs in the same change.
- Prefer pointing at the exact module that owns the behavior (single source of truth).

## 4) VS Code extension specifics

This repository is a **VS Code extension**. Agents must follow these rules when changing extension code.

- **VS Code API**: Always target the `vscode` namespace.
- **Proposed APIs**: Use `@vscode/dts` and keep `src/vscode.d.ts` current when relying on proposed types.
- **Secrets**: Use `ConfigManager` (wraps `context.secrets`) for API keys. **Never** use `globalState`.

### Architecture & data flow (extension)

This extension integrates LiteLLM proxies into VS Code's Language Model Chat API.

- **Entry Point**: `src/extension.ts` — activates the extension and registers the `litellm-connector` provider.
- **Provider**: `src/providers/liteLLMProvider.ts` — implements `vscode.LanguageModelChatProvider` and orchestrates model discovery, request conversion, and streaming.
- **Adapters**:
  - `src/adapters/litellmClient.ts` — HTTP client for `/chat/completions`.
  - `src/adapters/responsesClient.ts` & `src/adapters/responsesAdapter.ts` — LiteLLM `/responses` endpoint support.
- **Config**: `src/config/configManager.ts` — user settings (Base URL, API Key) via `vscode.SecretStorage`.
- **Token management**: `src/adapters/tokenUtils.ts` — trimming and budget calculations.

### Key logic (extension)
- **Request part conversion**: handle `LanguageModelTextPart` and `LanguageModelBinaryPart` (vision) correctly; images must be encoded for OpenAI-compatible payloads.
- **Parameter filtering**: keep `KNOWN_PARAMETER_LIMITATIONS` up to date to strip unsupported parameters for specific model families.
- **Streaming/buffering**: maintain correct streaming state; buffer partial tool-call chunks when SSE frames arrive fragmented.

### External dependencies
- **LiteLLM**: expects a compatible OpenAI-like proxy.
- **GitHub Copilot Chat**: this extension is a *provider* for the official Copilot Chat extension.

## 5) Change workflow (agent/CI)

### Commands
- `npm run lint` — ESLint checks (may apply autofixes depending on config)
- `npm run format` — Prettier formatting
- `npm run compile` — TypeScript typecheck/build validation
- `npm run test` — Unit tests
- `npm run test:coverage` — Unit tests with coverage report

### When to run what
- Before/after non-trivial edits: run `npm run compile` and `npm run test`.
- Before opening/updating a PR: run `npm run lint`, `npm run format`, `npm run test:coverage`.

## 6) Updating existing code

Any code you edit must be brought up to these standards:
- simplify and clarify while touching it
- add/adjust tests to cover new and existing behavior
- ensure coverage does not regress beyond the allowed threshold

## 7) Definition of done (agent checklist)
- [ ] Code is readable at a glance; no unnecessary complexity.
- [ ] New logic is modular and reused where appropriate.
- [ ] Logging added at major function entry/exit and critical decisions (where applicable).
- [ ] Telemetry updated for request outcomes and performance (where applicable).
- [ ] Tests added/updated; intent is clear from test names.
- [ ] Coverage meets targets and does not regress > 1% in any category.
- [ ] No secrets stored outside `ConfigManager` / `SecretStorage`.
