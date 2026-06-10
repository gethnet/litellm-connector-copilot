---
name: Test and Log Selected Code
description: >
 Generate comprehensive unit tests for the selected code block and add
 appropriate structured logging using the project's StructuredLogger.
 Use when: a block of TypeScript code has been selected and the user
 wants both test coverage and observability improvements applied to it.
argument-hint: Block of TypeScript code selected in the editor
agent: "agent"
---

# Test and Log Selected Code

You are a meticulous TypeScript engineer. The user has selected a block of
TypeScript code and wants you to:

1. **Write unit tests** that fully cover the selected block (TDD-first).
2. **Add structured logging** to the block where it is missing, using the
   project's `StructuredLogger` and choosing the **right log level** for
   each event so verbose details can be filtered out from real failures.

Both changes are expected in the same turn. Never skip either half of the
task.

## Required Reading Before Implementation

Before writing ANY code, the agent MUST read these files in order:

1. `AGENTS.md` — Repository standards, architecture, and TDD workflow.
2. `.github/instructions/typescript-no-any.instructions.md` — Strict
   type-safety rules. **No `any`** in tests or production code.
3. `.github/skills/vscode-extension-implementation/SKILL.md` — TDD-first
   workflow and validation expectations.
4. `src/observability/structuredLogger.ts` — Logger API surface
   (`trace`, `debug`, `info`, `warn`, `error`).
5. `src/observability/types.ts` — `EventType` enum; reuse existing
   event names when one fits semantically, otherwise use a new namespaced
   string (e.g. `"<area>.<verb>"`).
6. The file containing the **selected** code, in full.

If a conflict exists, `AGENTS.md` takes precedence.

## Inputs

- **Selected code**: the active editor selection in
  `<currentFile>` at lines `<startLine>`–`<endLine>`.
- **Target file**: the file containing the selection.
- **Existing tests**: discover any sibling `*.test.ts` co-located with
  the target (e.g. `src/<area>/test/<file>.test.ts`) and follow their
  patterns (assertion style, suite structure, mock approach).

## Workflow

### Step 1 — Read & characterize the selection

- Identify the public/private functions, branches, I/O operations, and
  state transitions inside the selection.
- Note any missing observability: functions with no entry/exit logs,
  branches that decide between outcomes, exception paths, fallbacks.
- Note any untested behavior: branches without coverage, edge cases,
  error handling, boundary inputs (empty arrays, null, undefined,
  malformed data).

### Step 2 — Write failing tests FIRST

Follow the project's TDD rules. **Always write the test before the
production change** so you can watch it fail and then make it pass.

- Place tests in the project's standard location for the target file
  (e.g. `src/<area>/test/<name>.test.ts`, or co-located
  `src/<area>/<name>.test.ts` if that is the existing convention).
- Match the existing test style (Mocha-style `suite`/`test` is used in
  this repo; see `src/adapters/test/tokenUtils.test.ts` for the
  canonical pattern with `assert.strictEqual`).
- Cover, at minimum:
  - The **happy path** for every public function in the selection.
  - **Each branch** (if/else, switch arms, ternary, early returns).
  - **Edge cases**: empty input, null/undefined, zero-length strings,
    non-string inputs (numbers, arrays, objects), boundary values.
  - **Error paths**: invalid shapes, malformed JSON, mismatched types.
  - **Type guards** in the code: confirm they correctly accept and
    reject.
- **No `any`** in tests. Use `unknown` plus type guards or
  `as unknown as <ConcreteType>` casts for VS Code message shapes.
- Each test name must describe the behavior it protects.

**Verify the new tests fail (or that new branches fail) before adding
production changes.** Run:

```bash
npm run test -- --grep "<new test name>"
```

Document the actual failure in your reasoning before continuing.

### Step 3 — Add structured logging with **intelligent level choice**

Use `StructuredLogger` from `src/observability/structuredLogger.ts`. Import
it like this:

```typescript
import { StructuredLogger } from "<relative-path>/observability/structuredLogger";
```

Choose the log level by **what the operator needs to see at default
"info" verbosity**, and what they would want to suppress when chasing
real failures.

| Level   | Use for                                                                                       | Should appear at default `info`? |
| ------- | --------------------------------------------------------------------------------------------- | ------------------------------- |
| `error` | Hard failures, thrown exceptions, quota exhaustion, request failures.                          | **Yes**                          |
| `warn`  | Recoverable issues, parameter suppression, unexpected but tolerated shapes, sanitized inputs. | **Yes**                          |
| `info`  | High-level lifecycle events: function entry/exit at coarse granularity, completion status.    | **Yes**                          |
| `debug` | Detailed flow information, branch decisions, intermediate values, endpoint selection.          | No (suppress at default)         |
| `trace` | Full payloads, raw data, per-iteration counters, exhaustive part-by-part traces.              | No (suppress at default)         |

**Decision rules for picking a level** (apply in order):

1. If the event represents a **failure** that breaks the request, use
   `error`. Always include the error object/cause and a stable
   correlation key.
2. If the event represents a **fallback, suppression, or
   degradation** that the system handled gracefully, use `warn`.
3. If the event is a **lifecycle milestone** (request started,
   function entered, function completed, count returned), use `info`.
4. If the event is a **branch decision** the operator would only want
   to see when debugging, use `debug`.
5. If the event is a **per-element trace** (every loop iteration,
   every part counted, every byte encoded), use `trace`.

**Sanitization rules**:

- Never log API keys, tokens, secrets, raw request bodies, or
  user-identifying data.
- Truncate or hash large payloads; log only `{ length, hash, keys }` if
  needed.
- Reuse the project's existing sanitization helpers if present.

**Style rules**:

- Use the project convention: `StructuredLogger.<level>("<area>.<verb>", { ...data }, { requestId?, model?, endpoint?, caller? })`.
- Event names must be **dotted, present-tense, past-tense consistent
  with neighbors**: `tokenizer.part_counted`, `tokenizer.part_skipped`,
  `tokenizer.branch_entered`.
- Include the **inputs that drove the decision** (e.g.
  `{ hasValue: typeof part === "object" && "value" in part }`) so the
  log is self-explanatory without re-running the code.
- Add `requestId`/`model`/`endpoint` in the options bag if a
  correlation context is available; otherwise omit (the logger fills
  in `"no-request"`).

### Step 4 — Implement the minimal production change

- Make the failing tests pass with the **smallest** change.
- Keep the function signatures unchanged unless tests demand it.
- Preserve all existing behavior for callers.
- Update JSDoc to mention what is now logged and at which level.
- Do not introduce new dependencies.

### Step 5 — Verify

Run all of these and confirm success:

```bash
npm run compile                 # 0 errors
npm run test -- --grep "<new tests>"   # All new tests pass
npm run test:coverage           # Coverage ≥ 85% lines, no category regresses >1%
npm run lint                    # 0 errors
npm run format                  # Prettier clean
```

### Step 6 — Update the changelog (if the project requires it)

If the repo maintains `CHANGELOG.md` and this change is user-visible,
add a one-line entry under the current unreleased section, following
the repo's emoji + concise style.

## File-level change specification

For every file touched, produce a section like:

### File: `src/<area>/<name>.ts`
**Action:** MODIFY
**Purpose:** Add structured logging to the selected block.

#### Changes
1. **Location:** Lines X–Y (function `<name>`)
   **What:** Add `info` entry log + `debug` branch-decision logs.
   **Code:** the exact `+`/`-` diff.

### File: `src/<area>/test/<name>.test.ts`
**Action:** CREATE or MODIFY
**Purpose:** Cover all branches in the selection.

#### Changes
1. **Location:** New `suite('<SuiteName>', () => { ... })`
   **What:** Test list with descriptions.
   **Code:** exact test bodies.

## Anti-patterns — NEVER Do These

| ❌ Bad                                                  | ✅ Good                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| Log every iteration at `info`                          | Log the **summary** at `info`; per-iteration at `trace`       |
| Use `any` in test fixtures                             | Use `unknown` + `as unknown as <Type>` for VS Code message shapes |
| Write `logger.info('Done')` with no data              | `StructuredLogger.info('tokenizer.counted', { tokens, ms })`  |
| Log API keys, raw payloads, or user PII                | Log `{ length, hash, keys }` instead                          |
| Add tests that always pass (asserting `true`)          | Cover the actual return value and side effects                |
| Modify code outside the selection without justification | Stay within the selected block unless tests demand a refactor |
| Suppress `@typescript-eslint/no-explicit-any`          | Fix the type properly                                          |
| Skip running tests after the change                    | Always run `npm run test:coverage` and confirm green          |

## Definition of done (per AGENTS.md §7)

- [ ] New tests written **before** the production change and observed to fail.
- [ ] All new tests pass; full test suite passes; coverage ≥ 85% lines
      and no category regresses >1%.
- [ ] Logging uses `StructuredLogger` and the chosen level matches the
      decision rules above.
- [ ] No `any` introduced.
- [ ] No secrets/PII logged.
- [ ] `npm run compile`, `npm run lint`, `npm run format` all clean.
- [ ] JSDoc updated to document the new log events.
- [ ] No files outside the selection's logical area were modified.

## Example output (illustrative)

```typescript
// src/adapters/tokenizers/heuristicTokenizer.ts (modified selection)
private countPartTokens(part: unknown): number {
    StructuredLogger.trace("tokenizer.part_inspected", {
        isObject: typeof part === "object" && part !== null,
        keys: typeof part === "object" && part !== null ? Object.keys(part) : [],
    });

    if (typeof part !== "object" || part === null) {
        StructuredLogger.trace("tokenizer.part_skipped", { reason: "not-object" });
        return 0;
    }

    if ("value" in part) {
        const value = (part as { value?: string | string[] }).value;
        if (typeof value === "string") {
            const n = this.countTokens(value).tokens;
            StructuredLogger.debug("tokenizer.part_counted", { kind: "string", tokens: n });
            return n;
        }
        if (Array.isArray(value)) {
            const n = this.countTokens(value.join("")).tokens;
            StructuredLogger.debug("tokenizer.part_counted", { kind: "string[]", tokens: n });
            return n;
        }
    }
    // ... rest unchanged ...
}
```

And the matching test:

```typescript
test("countPartTokens returns 0 for non-object inputs", () => {
    const t = new HeuristicTokenizer();
    assert.strictEqual(t["countPartTokens"](null), 0);
    assert.strictEqual(t["countPartTokens"]("not an object"), 0);
    assert.strictEqual(t["countPartTokens"](42), 0);
});

test("countPartTokens counts string values via countTokens", () => {
    const t = new HeuristicTokenizer();
    const part = { value: "Hello world" };
    assert.strictEqual(t["countPartTokens"](part), t.countTokens("Hello world").tokens);
});
```

## Invocation examples

- `/test-and-log` — runs against the active selection.
- `/test-and-log src/adapters/tokenizers/heuristicTokenizer.ts:36-77` —
  runs against a specific block when no selection is active.
