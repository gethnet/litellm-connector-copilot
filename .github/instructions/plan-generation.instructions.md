---
description: "Use when generating implementation plans, task breakdowns, or step-by-step coding guides. Enforces exhaustive detail, explicit code generation, and mandatory skill/instruction references."
applyTo: "**/*.prompt.md,**/*.instructions.md,**/*.agent.md,**/*.plan.md"
---

# Plan Generation Standards

## Core Principle
**Plans are contracts for autonomous code generation.** The implementation agent must be able to execute the plan without asking questions, inferring context, or leaving work for the user.

## Non-Negotiable Plan Requirements

### 1. Every Step Produces Code
- **NEVER** write "implement X" without providing the exact code to write
- **NEVER** use placeholders like `// TODO`, `// implement this`, `// your code here`
- **NEVER** assume the user will complete any implementation step
- **ALWAYS** provide complete, copy-pasteable code blocks for every change
- If a step modifies existing code, show the **exact before and after** with surrounding context

### 2. Mandatory Skill & Instruction References
At the top of every plan, include a **Required Reading** section:
```markdown
## Required Reading Before Implementation
Before writing ANY code, the agent MUST read these files in order:
1. `AGENTS.md` — Repository standards and architecture
2. `.github/instructions/typescript-no-any.instructions.md` — Type safety rules
3. `.github/skills/vscode-extension-implementation/SKILL.md` — Implementation workflow
4. [Any other relevant skill/instruction files]

The agent MUST follow ALL rules from these files. If a conflict exists, AGENTS.md takes precedence.
```

### 3. File-Level Change Specifications
For EVERY file that will be modified or created:
```markdown
### File: `src/path/to/file.ts`
**Action:** [CREATE | MODIFY | DELETE]
**Purpose:** [Why this file exists/changes]
**Dependencies:** [What must exist before this file works]

#### Changes:
1. **Location:** Lines X-Y (or "Add after line X")
   **What:** [Exact description]
   **Code:**
   ```typescript
   // EXACT CODE TO INSERT/MODIFY
   ```

2. **Location:** Lines A-B
   **What:** [Exact description]
   **Code:**
   ```typescript
   // EXACT CODE
   ```
```

### 4. Verification Checkpoints
After each major step, include explicit verification:
```markdown
### Verification: After Step N
Run these commands and confirm expected output:
```bash
npm run compile  # Must pass with 0 errors
npm run test -- --grep "specific test name"  # Must pass
```
**Expected:** [What success looks like]
**If failed:** [Exact fix steps]
```

### 5. Test-First Enforcement
If the task involves behavior changes:
```markdown
## Step 1: Write Failing Test FIRST
Before ANY implementation, create the test that proves the behavior.

### Test File: `src/module/test/feature.test.ts`
**Create/modify with this exact test:**
```typescript
describe('FeatureName', () => {
  it('should [expected behavior]', () => {
    // EXACT TEST CODE
  });
});
```

**Verify it fails:** Run `npm run test` and confirm the new test fails.
**Only then proceed to implementation.**
```

## Plan Structure Template

```markdown
# Implementation Plan: [Feature/Fix Name]

## Context
[Why this change is needed — 2-3 sentences max]

## Required Reading Before Implementation
1. `AGENTS.md` — [Specific sections to focus on]
2. `.github/instructions/typescript-no-any.instructions.md`
3. `.github/skills/vscode-extension-implementation/SKILL.md`
4. [Other relevant files]

**The agent MUST read ALL listed files before writing any code.**

## Pre-Implementation Checklist
- [ ] Read all Required Reading files
- [ ] Run `npm run compile` to confirm clean starting state
- [ ] Run `npm run test:coverage` to establish baseline

## Changes Overview
| File | Action | Purpose |
|------|--------|---------|
| `src/x.ts` | MODIFY | Add new method |
| `src/x.test.ts` | MODIFY | Add tests |
| `src/y.ts` | CREATE | New utility |

## Step 1: [Test Name] — Write Failing Test
### File: `src/path/test/file.test.ts`
**Action:** MODIFY — Add new test case

**Add after line X:**
```typescript
// EXACT TEST CODE
```

**Verify failure:**
```bash
npm run test -- --grep "test name"
```
**Expected:** Test fails with [specific error]

## Step 2: [Implementation Name]
### File: `src/path/file.ts`
**Action:** MODIFY — Implement feature

**Find this code (lines X-Y):**
```typescript
// EXISTING CODE TO FIND
```

**Replace with:**
```typescript
// NEW CODE
```

## Step 3: Verify Tests Pass
```bash
npm run test:coverage
```
**Expected:** All tests pass, coverage ≥ 85% lines

## Step 4: Lint and Format
```bash
npm run lint
npm run format
```
**Expected:** No errors

## Step 5: Final Verification
```bash
npm run compile
npm run test:coverage
```
**Expected:** Clean compile, coverage meets targets

## Rollback Plan
If any step fails:
1. [Specific rollback action]
2. [How to diagnose the issue]
```

## Anti-Patterns — NEVER Do These

| ❌ Bad | ✅ Good |
|--------|---------|
| "Add the new method to the class" | "Add this method after line 45: `code block`" |
| "Update the test file" | "In `file.test.ts` at line 23, add: `code block`" |
| "Handle the error case" | "Wrap in try-catch: `exact code`" |
| "See AGENTS.md for standards" | "Per AGENTS.md §3, use pattern X: `code example`" |
| "Implement the interface" | "Add these methods to satisfy InterfaceName: `code`" |
| "// TODO: add validation" | "Add validation: `if (!x) throw new Error('...')`" |

## Enforcement

The implementation agent MUST:
1. Read ALL files listed in Required Reading before starting
2. Follow the plan step-by-step without deviation
3. Write the exact code specified in each step
4. Run ALL verification commands and confirm success
5. NOT skip any step, even if it seems obvious
6. NOT add code beyond what the plan specifies
7. NOT modify files not listed in the Changes Overview

If the agent encounters ambiguity, it MUST stop and request clarification rather than assume.
