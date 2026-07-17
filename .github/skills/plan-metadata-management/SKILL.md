---
name: plan-metadata-management
description: "Use when creating, reviewing, repairing, or updating YAML frontmatter metadata for implementation plans in .plans/. Covers plan lifecycle status, archive records, GitHub traceability, implementation commits, release versions, validation results, and schema compliance."
argument-hint: "Plan path and metadata update to make"
user-invocable: true
---

# Plan Metadata Management

Maintain searchable, factual YAML frontmatter for implementation plans while preserving their `*.prompt.md` role as executable agent instructions.

## Source of Truth

Read both files before changing plan metadata:

1. [Plan metadata schema](../../schemas/plan-metadata.schema.json) — field types, allowed values, and conditional requirements.
2. [Plan metadata guide](../../schemas/plan-metadata.md) — lifecycle semantics, examples, and evolution rules.

The schema is authoritative. If the schema and a plan disagree, update the plan unless the task explicitly requests a schema revision.

## Workflow

1. Read the complete target plan, including YAML frontmatter and implementation details.
2. Verify the plan location and its current `status`; directory placement is a signal but frontmatter is the lifecycle source of truth.
3. Gather only corroborated facts:
   - use the user-provided data when it is explicit;
   - cross-check issue, pull request, commit, release, touched-file, and validation claims against the repository when possible;
   - do not invent identifiers, dates, authors, outcomes, validation results, or release versions.
4. Preserve the stable `id`, even if the plan was renamed or moved.
5. Apply the smallest metadata-only update that reflects verified facts.
6. Re-read the frontmatter and validate it against the schema's required fields, enums, and terminal-state conditions.
7. Report changed fields and facts that could not be verified. Do not edit the plan body unless the user explicitly requests plan-content changes.

## Lifecycle Rules

- New plans use `status: proposed` or `status: pending` as appropriate.
- An implementation may start only from `status: pending`; update to `in_progress` when that transition is known.
- A successful finished implementation uses `status: completed`, `outcome: implemented`, and `completed_at`.
- A partially delivered plan uses `status: completed` and `outcome: partially_implemented`.
- A closed plan with no code change uses `status: completed` and `outcome: not_implemented`, or `status: abandoned` when deliberately discarded.
- A replacement uses `status: superseded`, `outcome: replaced`, and `relationships.superseded_by`.
- Moving a plan to `.plans/archived` does not change a terminal status. Set `archived_at` when the archive date is known.

## Data Quality Rules

- Use quoted ISO calendar dates: `"YYYY-MM-DD"`.
- Omit unknown optional fields rather than using empty strings, `null`, `TBD`, or guessed values.
- Use repository-local numeric IDs in `github.issues` and `github.pull_requests`.
- Record commit hashes under `implementation.commits`; record the first containing release under `implementation.release_version`.
- Keep `areas` architectural and stable; use `tags` for flexible topics.
- Treat `validation` as a factual result. Mark a check `passed` only when it was actually run and succeeded; otherwise omit it or use `not_run` when recording an intentional incomplete validation state.
- Do not change `schema_version` unless revising the schema contract itself.

## Minimal Templates

### Pending plan

```yaml
---
schema_version: 1
id: stable-kebab-case-id
title: Human-readable title
plan_kind: bug_fix
status: pending
description: One sentence describing the intended outcome.
created_at: "YYYY-MM-DD"
areas:
  - providers
tags:
  - litellm
---
```

### Completed archived plan

```yaml
---
schema_version: 1
id: stable-kebab-case-id
title: Human-readable title
plan_kind: bug_fix
status: completed
outcome: implemented
description: One sentence describing the intended outcome.
created_at: "YYYY-MM-DD"
completed_at: "YYYY-MM-DD"
archived_at: "YYYY-MM-DD"
areas:
  - providers
tags:
  - litellm
github:
  issues:
    - 123
  pull_requests:
    - 124
implementation:
  commits:
    - abc123def456
  release_version: "2.2.0"
validation:
  compile: passed
  lint: passed
  format: passed
  test_coverage: passed
---
```
