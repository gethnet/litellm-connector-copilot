---
description: "Use when writing or modifying any code under src/. Summarizes the review gates the PR Reviewer agent enforces so changes pass review the first time: TDD evidence, coverage minimums, file size limits, provider architecture boundaries, secrets handling, and validation commands."
applyTo: "src/**"
---

# Code Review Gates (enforced on every PR)

Every change under `src/` is reviewed against these gates by the PR Reviewer agent. Write code that passes them the first time. `AGENTS.md` is the source of truth — this is the condensed checklist.

## Gate A — Non-negotiables
- **TDD evidence**: behavior changes ship with new/updated tests; bug fixes ship a regression test that fails before the fix.
- **KISS / DRY**: no duplicated logic that belongs in a shared helper, adapter, or `LiteLLMProviderBase`; no cleverness over clarity.
- **File size**: no TypeScript file may reach **1000 lines** — split into sub-modules before approaching the limit.
- **Placement**: code lives in the most specific owning folder (`providers/`, `adapters/`, `utils/`, `config/`, `commands/`); tests co-located under `src/**/test/`.
- **Documentation**: non-obvious blocks (request shaping, streaming, retries, trimming, error handling) carry *why*-comments stating assumptions and invariants.

## Gate B — Instruction conformance
- No `any` anywhere (`typescript-no-any.instructions.md`) — includes tests.
- `StructuredLogger` calls use the correct level per `logging-levels.instructions.md`.
- Telemetry changes follow `telemetry.instructions.md` (PostHog standards, event naming, tests).

## Gate C — Extension architecture (when touching `src/providers/`, `src/adapters/`, `src/extension.ts`, or `package.json`)
- Exactly **one** chat provider (`LiteLLMChatProvider`); never introduce version-suffixed siblings.
- Shared orchestration stays in `LiteLLMProviderBase`; protocol specifics stay in the derived provider.
- Read per-group config from `options.configuration` on **every** call — no global config caching.
- Model info sets `isUserSelectable: true` and `category: { label, order }`; reasoning models include `group: "navigation"` on `reasoningEffort`.
- BackendRegistry writes are internal-only; consumers use `discoverModels` / `lookup` / read APIs.
- Secrets only via `ConfigManager` / `SecretStorage` — never `globalState`.

## Gate D — Tests & coverage
- **Lines ≥ 85%**; no coverage category regresses **> 1%**.
- Tests are explanatory (name states the behavior), deterministic, and `any`-free.

## Gate E — Validation before finishing
Run independently and confirm each passes: `npm run compile` → `npm run lint` → `npm run format` → `npm run test:coverage`. Never run `npm run test` or `npm run check`.

## Gate F — Communication
- Commit/PR titles: 1–2 leading emojis, concise, outcome-focused (e.g. `🛠️ Fix tool-call id normalization`).
- Update `AGENTS.md` architecture notes in the same change when files are renamed or responsibility moves.
