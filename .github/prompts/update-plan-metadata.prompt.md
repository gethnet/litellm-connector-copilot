---
name: update-plan-metadata
description: "Update an implementation plan's YAML metadata with user-supplied facts and repository-verified lifecycle, GitHub, implementation, release, and validation data."
argument-hint: "Plan path, followed by any facts to record"
agent: "agent"
---

# Update Plan Metadata

Update the metadata of the plan specified by the user. This is a metadata-maintenance task, not an implementation or plan-body rewrite task.

## Required Reading

Before editing, read:

1. `.github/skills/plan-metadata-management/SKILL.md`
2. `.github/schemas/plan-metadata.schema.json`
3. `.github/schemas/plan-metadata.md`
4. The complete plan file supplied by the user

## Procedure

1. Parse the user's input into a plan path and claimed facts.
2. Confirm the plan exists under `.plans/` and read its complete YAML frontmatter and body.
3. Cross-check claimed facts against the repository where possible:
   - verify Git commit hashes and branches with Git;
   - inspect relevant files to confirm `affected_files`, `areas`, and `tags` when they are supplied or changed;
   - use available GitHub context for issue and pull request numbers when relevant;
   - record validation results only when command output or explicit user evidence supports them.
4. Treat explicit user facts as authoritative when they cannot be independently verified, but do not invent missing values.
5. Edit only the YAML frontmatter unless the user explicitly asks to revise the plan body.
6. Preserve `id` and `created_at`, omit unknown optional values, and use quoted ISO dates.
7. Enforce lifecycle rules from the schema:
   - `completed` requires `completed_at` and `outcome`;
   - `superseded` requires `outcome: replaced` and `relationships.superseded_by`;
   - archival uses `archived_at` without changing an existing terminal status.
8. Re-read the edited plan and confirm that its frontmatter satisfies the schema.

## Response Format

Report:

- the plan path;
- each metadata field added, changed, or removed;
- evidence used for cross-checked facts;
- any supplied fact that could not be verified;
- any intentionally omitted unknown metadata.

## User Input

{{$input}}
