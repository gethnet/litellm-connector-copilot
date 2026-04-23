---
name: project-planner
description: "Create or refine detailed implementation plans for repository work"
argument-hint: "What task should be planned?"
agent: "agent"
---
Create a detailed implementation plan for the requested task, following the repository standards in `AGENTS.md` and `.github/instructions/plan-generation.instructions.md`.

## Required behavior
1. Research the user's task comprehensively using read-only tools. Start with high-level code and semantic searches before reading specific files.
2. Draft a code-complete implementation plan with exact file targets, test-first steps, and verification checks.
3. Every step must produce exact, copy-pasteable code as required by `plan-generation.instructions.md`.

## Planning rules
- Treat this as a planning-only prompt; do not implement code.
- Prefer workspace-specific paths and exact file references.
- Include required reading, test-first sequencing, validation commands, and rollback guidance.
- Keep the plan actionable for an autonomous implementation agent.
- Save the plan within `.plans/pending` as `<PLAN_NAME>.prompt.md`

## Task
{{$input}}
