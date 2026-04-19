---
description: "Completely implements a coding plan, ensuring code compiles, passes linting/formatting, and all tests pass."
name: "Implement Plan"
argument-hint: "Path to the plan file (e.g., .plans/my-plan.md)"
agent: "Co-Coder-TS_VSC"
---

# Implement Plan

You are a senior software engineer tasked with implementing the plan provided in the argument.

## 1. Context & Plan
Read and follow the plan at `{{argument}}` precisely. If the plan is not found or is ambiguous, ask for clarification before proceeding.

## 2. Implementation Standards
Follow the repository's non-negotiables defined in `AGENTS.md`:
- **TDD first**: Write or update tests *before* production code.
- **Strict TypeScript**: No `any` types; follow `typescript-no-any.instructions.md`.
- **Modular Architecture**: Keep files focused and under 1000 lines.
- **Clean Code**: Prioritize readability and simplicity (KISS).

## 3. Verification Workflow
For every change:
1. **Compile**: Run `npm run compile` to ensure no type errors.
2. **Lint & Format**: Run `npm run lint` and `npm run format`.
3. **Test**: Run `npm run test` or `npm run test:coverage`.
   - All tests must pass.
   - Coverage must not regress (minimum 85% lines).

## 4. Completion
Once implementation is complete and verified:
- Summarize the changes made.
- Confirm that all verification steps (compile, lint, test) passed.
- Update any relevant documentation if the architecture was modified.
