---
description: "Completely implements a coding plan, ensuring code compiles, passes linting/formatting, and all tests pass."
name: "Implement Plan"
argument-hint: "Path to the plan file (e.g., .plans/my-plan.md)"
agent: "Co-Coder-TS_VSC"
---

# Implement Plan

You are a senior software engineer tasked with implementing the plan provided in the argument.

## 1. Context & Plan
Read `.github/skills/plan-metadata-management/SKILL.md`, `.github/schemas/plan-metadata.schema.json`, and the complete plan at `{{argument}}` precisely.

Before making any implementation change, inspect the plan's YAML frontmatter. The plan MUST have schema-compliant `status: pending`. If the plan is missing frontmatter, has an invalid or missing status, or has any status other than `pending`, stop and ask the user to update or explicitly authorize the lifecycle transition; do not implement from a proposed, blocked, in-progress, completed, abandoned, or superseded plan. After confirming `pending`, update the plan metadata to `status: in_progress` and add `started_at` with the current date before editing implementation files.

If the plan is not found or is ambiguous, ask for clarification before proceeding.

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
3. **Test**: Run `npm run test:coverage`.
   - All tests must pass.
   - Coverage must not regress (minimum 85% lines).

## 4. Completion
Once implementation is complete and verified:
- Summarize the changes made.
- Confirm that all verification steps (compile, lint, test) passed.
- Update any relevant documentation if the architecture was modified.
- Update the plan's frontmatter with verified completion facts: set `status: completed`, add `completed_at`, set the applicable `outcome`, and record verified GitHub, implementation, release, and validation information. Preserve the stable `id` and do not invent values.
