---
name: Add Logging Only
description: >
 Add structured logging to the selected code block using the project's
 StructuredLogger, without writing tests. Use when: test coverage already
 exists and the user wants observability improvements only.
argument-hint: Block of TypeScript code selected in the editor
agent: "agent"
---

# Add Logging Only

You are a meticulous TypeScript engineer. The user has selected a block of
TypeScript code and wants you to **add structured logging only** — no tests
are needed. Treat the selected code as the single source of truth for what
needs to become observable.

## Required Reading Before Implementation

Before writing ANY code, the agent MUST read these files in order:

1. `AGENTS.md` — Repository standards and architecture.
2. `.github/instructions/typescript-no-any.instructions.md` — Strict
   type-safety rules. **No `any`** in production code.
3. `.github/instructions/logging-levels.instructions.md` — The per-level
   decision table and sanitization rules. **All level choices come from
   this file.**
4. `src/observability/structuredLogger.ts` — Logger API surface
   (`trace`, `debug`, `info`, `warn`, `error`).
5. `src/observability/types.ts` — `EventType` enum; reuse existing
   event names when one fits semantically, otherwise use a new namespaced
   string (e.g. `"<area>.<verb>"`).
6. The file containing the **selected** code, in full.

If a conflict exists, `AGENTS.md` takes precedence.

## Inputs

- **Selected code**: the active editor selection in `<currentFile>`.
- **Target file**: the file containing the selection.

## Workflow

### Step 1 — Read & characterize the selection

- Identify the public/private functions, branches, I/O operations, and
  state transitions inside the selection.
- Note any missing observability: functions with no entry/exit logs,
  branches that decide between outcomes, exception paths, fallbacks.
- Do **not** write tests. The user confirmed coverage already exists.

### Step 2 — Add structured logging

Use `StructuredLogger` from `src/observability/structuredLogger.ts`.
Import it like this:

```typescript
import { StructuredLogger } from "<relative-path>/observability/structuredLogger";
```

**Choose the log level** using the decision algorithm from
`.github/instructions/logging-levels.instructions.md`:

| Level   | Use for                                                                                       | Visible at default `info`? |
| ------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| `error` | Hard failures, thrown exceptions, quota exhaustion, request failures.                          | **Yes**                     |
| `warn`  | Recoverable issues, parameter suppression, unexpected but tolerated shapes.                    | **Yes**                     |
| `info`  | High-level lifecycle events: function entry/exit at coarse granularity, completion status.    | **Yes**                     |
| `debug` | Detailed flow information, branch decisions, intermediate values, endpoint selection.          | No (suppress at default)    |
| `trace` | Full payloads, raw data, per-iteration counters, exhaustive part-by-part traces.              | No (suppress at default)    |

**Rules** (apply in order):

1. If the event represents a **failure that breaks the request**, use
   `error`.
2. If the event represents a **fallback, suppression, or degradation**,
   use `warn`.
3. If the event is a **lifecycle milestone**, use `info`.
4. If the event is a **branch decision**, use `debug`.
5. If the event is a **per-element trace**, use `trace`.

**Event name** — dotted, present-tense, namespaced by area:
`tokenizer.part_counted`, `stream.tool_call_buffered`, `v2.convert.completed`.
Reuse the existing `EventType` enum in `src/observability/types.ts` when
one fits; otherwise use a new namespaced string.

**Data** — include the inputs that drove the decision, not a static string.
Never log secrets, raw request bodies, or PII.

**Sanitization** — truncate or hash large payloads. `Uint8Array` payloads
must be summarized as `{ byteLength }`, not converted to a string.

**JSDoc** — update the function's JSDoc to document the new log events
and their levels.

### Step 3 — Verify

Run all of these and confirm success:

```bash
npm run compile                 # 0 errors
npm run test:coverage           # Coverage ≥ 85% lines, no category regresses >1%
npm run lint                    # 0 errors
npm run format                  # Prettier clean
```

If tests break after adding logging, the logging is too invasive — prefer
`trace`/`debug` to keep side effects minimal. Wrap logging in a no-op
fallback (`try { StructuredLogger ... } catch { /* swallow */ }`) only
if the logger is unavailable in the module's test harness; do **not**
wrap in production code.

### Step 4 — Update the changelog (if the project requires it)

If `CHANGELOG.md` has an unreleased section and this change is
user-visible, add a one-line entry following the repo's emoji + concise
style.

## File-level change specification

For every file touched, produce a section like:

### File: `src/<area>/<name>.ts`
**Action:** MODIFY
**Purpose:** Add structured logging to the selected block.

#### Changes
1. **Location:** Lines X–Y (function `<name>`)
   **What:** Add `info` entry log + `debug` branch-decision logs.
   **Code:** the exact change (use `replace_string_in_file` /
   `insert_edit_into_file`, not raw code blocks).

## Anti-patterns — NEVER Do These

| ❌ Bad                                                  | ✅ Good                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| Log every iteration at `info`                          | Log the **summary** at `info`; per-iteration at `trace`       |
| Use `any` in production code                           | Use `unknown` + type guards or `as unknown as <Type>`          |
| Write `logger.info('Done')` with no data              | `StructuredLogger.info('tokenizer.counted', { tokens, ms })`  |
| Log API keys, raw payloads, or user PII                | Log `{ length, hash, keys }` instead                          |
| Wrap every log in `try/catch` to hide errors          | Let errors propagate; log on the failure path, not the normal one |
| Modify code outside the selection without justification | Stay within the selected block                                |
| Suppress `@typescript-eslint/no-explicit-any`          | Fix the type properly                                          |
| Skip running tests after the change                    | Always run `npm run test:coverage` and confirm green          |

## Definition of done (per AGENTS.md §7)

- [ ] Logging uses `StructuredLogger` and the chosen level matches the
      decision algorithm in `logging-levels.instructions.md`.
- [ ] No `any` introduced.
- [ ] No secrets/PII logged.
- [ ] `npm run compile`, `npm run lint`, `npm run format` all clean.
- [ ] JSDoc updated to document the new log events.
- [ ] No files outside the selection's logical area were modified.
- [ ] `npm run test:coverage` passes with no regression >1% in any
      category.
