---
description: "Use when creating, implementing, completing, archiving, moving, reviewing, or updating .plans implementation plans. Requires schema-compliant YAML metadata updates when verified lifecycle, GitHub traceability, implementation, release, or validation facts change."
applyTo: ".plans/**/*.prompt.md,.plans/**/*.plan.md,.plans/**/*.md"
---

# Plan Metadata Lifecycle Instructions

Plan YAML frontmatter is the searchable lifecycle record for every implementation plan. Follow the canonical [schema](../schemas/plan-metadata.schema.json) and [guide](../schemas/plan-metadata.md).

## When Metadata Must Be Updated

Update the target plan's frontmatter during a task when any verified fact below changes:

- a plan is created, accepted, started, blocked, completed, abandoned, superseded, moved, or archived;
- an associated GitHub issue, pull request, or discussion is identified;
- implementation commits, the implementation branch, or the first containing release are known;
- the plan's architectural areas, tags, or affected files materially change;
- compile, lint, format, or coverage validation is run and its final result needs recording;
- another plan becomes a dependency, related plan, replacement, or superseded predecessor.

Do not update metadata merely because a plan was read. Do not overwrite known facts with guesses.

## Required Procedure

1. Read the complete target plan and its current frontmatter.
2. Read `.github/skills/plan-metadata-management/SKILL.md` and the canonical schema before editing metadata.
3. Confirm each new value against user-provided evidence, the Git history, repository files, validation output, or GitHub data as appropriate.
4. Make the smallest metadata-only edit that reflects verified facts. Keep the plan body unchanged unless the task also requires body changes.
5. Preserve `id` and `created_at`; moving a plan does not create a new plan identity.
6. Re-read the changed frontmatter and confirm schema validity, including conditional terminal-state requirements.

## Lifecycle Requirements

- A plan must be `pending` before an implementation task begins. Inspect and confirm that state before changing implementation files. If it is `proposed`, `blocked`, terminal, or missing a valid status, stop and ask the user how to proceed.
- After confirming `pending` and before changing implementation files, update to `status: in_progress` and add `started_at` using the current date.
- On completed implementation, use `status: completed`, add `completed_at`, and record the appropriate `outcome`.
- Completed plans require `completed_at` and `outcome`.
- Superseded plans require `status: superseded`, `outcome: replaced`, and `relationships.superseded_by`.
- Archiving preserves the terminal lifecycle status; add `archived_at` if the archive date is known.

## Data Integrity

- Always use `schema_version: 1` for new metadata under the current contract.
- Use quoted ISO dates such as `"2026-07-17"`.
- Omit optional unknown fields. Never use empty strings, `null`, `TBD`, or invented values.
- `areas` are stable architectural labels; `tags` are flexible search labels.
- Record only actual validation outcomes. Do not write `passed` unless that command was run successfully.
- Keep `*.prompt.md` plan filenames: metadata supplements, rather than replaces, the plan's executable instruction role.
