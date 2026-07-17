---
name: project-planner
description: "Create or refine detailed implementation plans for repository work"
argument-hint: "What task should be planned?"
agent: "agent"
---
Create a detailed implementation plan for the requested task, following the repository standards in `AGENTS.md` and `.github/instructions/plan-generation.instructions.md`.

Before drafting, read `.github/schemas/plan-metadata.schema.json` and `.github/schemas/plan-metadata.md`.

## Required behavior
1. Research the user's task comprehensively using read-only tools. Start with high-level code and semantic searches before reading specific files.
2. Draft a code-complete implementation plan with exact file targets, test-first steps, and verification checks.
3. Every step must produce exact, copy-pasteable code as required by `plan-generation.instructions.md`.
4. Create a schema-compliant YAML metadata header with plan-specific required fields. Use `status: pending` for a plan ready to implement, omit unknown optional fields, and never use placeholder values.

## Planning rules
- Treat this as a planning-only prompt; do not implement code.
- Prefer workspace-specific paths and exact file references.
- Include required reading, test-first sequencing, validation commands, and rollback guidance.
- Preserve the executable `*.prompt.md` suffix; metadata supplements the implementation contract.
- Keep the plan actionable for an autonomous implementation agent.
- Save the plan within `.plans/pending` as `<PLAN_NAME>.prompt.md`

## Task
{{$input}}
