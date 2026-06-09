---
name: Add Tests Only
description: >
 Generate comprehensive unit tests for the selected code block without
 changing production code. Use when: observability is already sufficient
 and the user wants test coverage improvements only.
argument-hint: Block of TypeScript code selected in the editor
agent: "agent"
---

# Add Tests Only

You are a meticulous TypeScript engineer. The user has selected a block of
TypeScript code and wants you to **write unit tests only** — no
production changes are needed. Treat the selected code as the single
source of truth for what must be covered.

## Required Reading Before Implementation

Before writing ANY code, the agent MUST read these files in order:

1. `AGENTS.md` — Repository standards, architecture, and TDD workflow.
2. `.github/instructions/typescript-no-any.instructions.md` — Strict
   type-safety rules. **No `any`** in tests or production code.
3. `.github/skills/vscode-extension-implementation/SKILL.md` — TDD-first
   workflow and validation expectations.
4. The file containing the **selected** code, in full.
5. Any existing test files co-located with the target (discover via
   `file_search` with patterns like `src/<area>/test/*.test.ts` or
   `src/<area>/<name>.test.ts`).

If a conflict exists, `AGENTS.md` takes precedence.

## Inputs

- **Selected code**: the active editor selection in `<currentFile>`.
- **Target file**: the file containing the selection.
- **Existing tests**: discover sibling `*.test.ts` files and match their
  patterns (assertion style, suite structure, mock approach).

## Workflow

### Step 1 — Read & characterize the selection

- Identify every public/private function in the selection.
- Map each **branch** (if/else, switch arms, ternary, early return,
  guard clauses, fallbacks, catch blocks).
- Map each **type guard** and note what types it accepts/rejects.
- Map each **boundary condition** (empty input, null, undefined,
  zero-length strings, non-string inputs, boundary values, large
  payloads).
- Map each **error path** (malformed objects, invalid types, missing
  keys, unparseable JSON, cyclic references).

### Step 2 — Check for existing tests

Search for a co-located test file:
- `src/<area>/test/<name>.test.ts`
- `src/<area>/<name>.test.ts`
- `src/<area>/test/<name>.test.ts` (nested)

If a test file exists, **extend it** (add a new `test(...)` inside
the existing `suite(...)`). Do not duplicate existing test bodies.
Match the existing style exactly (Mocha-style `suite`/`test` with
`assert.strictEqual` is the canonical pattern in this repo; see
`src/adapters/test/tokenUtils.test.ts`).

If no test file exists, **create one** using the canonical pattern.

### Step 3 — Write the tests

**No production changes** are made in this workflow. The tests must
pass against the existing code. If a test cannot be satisfied without
a production change, stop and report that specific case to the user —
do not silently skip it or leave a `// TODO`.

**Test naming convention**: each `test(...)` name must describe the
behavior it protects. The name should answer: "what happens and under
what conditions?"

```typescript
test("countPartTokens returns 0 for non-object inputs", () => { ... });
test("countPartTokens counts string values via countTokens", () => { ... });
```

**Coverage requirements**:

For the selected block, cover, at minimum:

1. **Happy path** — every public function in the selection with
   representative valid inputs.
2. **Each branch** — every `if`/`else` arm, every `switch` case,
   every ternary truthy/falsy path, every early return.
3. **Edge cases** — empty input, null/undefined, zero-length strings,
   non-string inputs (numbers, arrays, objects), boundary values
   (0, -1, `Number.MAX_SAFE_INTEGER`, empty arrays, single-element
   arrays).
4. **Error paths** — invalid shapes, malformed JSON, mismatched
   types, missing keys.
5. **Type guards** — confirm they correctly accept and reject each
   shape.
6. **Recursion** (if the function is recursive) — depth-0 input,
   depth-1 input, depth-N input; verify the base case is hit.
7. **Buffer/encoding** (if the function uses `Buffer.from`) —
   valid UTF-8, valid binary data, zero-length buffer.

**No `any`** in tests. Use `unknown` plus type guards or
`as unknown as <ConcreteType>` casts for VS Code message shapes.
Never use `as unknown as any` — that is the same as `any`.

### Step 4 — Verify

Run all of these and confirm success:

```bash
npm run compile                 # 0 errors
npm run test -- --grep "<new test names>"  # All new tests pass
npm run test:coverage           # Coverage ≥ 85% lines, no category regresses >1%
npm run lint                    # 0 errors
npm run format                  # Prettier clean
```

If a test fails because the existing code has a bug, **do not fix
the production code**. Instead, mark the test with a comment:

```typescript
test("countPartTokens returns NaN for cyclic JSON input", () => {
    // NOTE: This documents a known bug — JSON.stringify throws on
    // cyclic objects and countPartTokens propagates the exception.
    // See issue #NNN.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => t["countPartTokens"](cyclic as { name?: string; input?: unknown }));
});
```

Report the bug finding to the user. Do not silently wrap it in a
`try/catch` in production code.

### Step 5 — Update the changelog (if the project requires it)

If `CHANGELOG.md` has an unreleased section and this change is
user-visible, add a one-line entry following the repo's emoji + concise
style.

## File-level change specification

For every file touched, produce a section like:

### File: `src/<area>/test/<name>.test.ts`
**Action:** CREATE or MODIFY
**Purpose:** Cover all branches in the selection.

#### Changes
1. **Location:** New `suite('<SuiteName>', () => { ... })` or
   addition to existing suite.
   **What:** Test list with descriptions.
   **Code:** the exact test bodies (use `insert_edit_into_file` /
   `replace_string_in_file`, not raw code blocks).

### File: `src/` files (production)
**Action:** NONE — no production changes in this workflow.

## Anti-patterns — NEVER Do These

| ❌ Bad                                                  | ✅ Good                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| Tests that always pass (`assert.strictEqual(1, 1)`)    | Tests that assert the **actual return value** of the function  |
| Use `any` in test fixtures                             | Use `unknown` + `as unknown as <Type>` for VS Code shapes     |
| Fix production code while writing tests                | Mark the failing test as a known bug, report to the user      |
| Duplicate existing tests                               | Extend the existing test file; check before creating new ones |
| Write tests for code outside the selection             | Stay within the selected block's behavioral contract           |
| Suppress `@typescript-eslint/no-explicit-any`          | Fix the type properly                                          |
| Skip running tests after writing them                  | Always run `npm run test:coverage` and confirm green          |
| Leave `// TODO: implement` in tests                    | Write the full test body or skip the test with a bug report   |

## Definition of done (per AGENTS.md §7)

- [ ] Tests written for every branch, edge case, and error path in
      the selection.
- [ ] No `any` introduced in tests.
- [ ] All tests pass against the existing production code.
- [ ] Coverage ≥ 85% lines and no category regresses >1%.
- [ ] No production files were modified.
- [ ] `npm run compile`, `npm run lint`, `npm run format` all clean.
- [ ] Test names clearly describe the behavior they protect.
