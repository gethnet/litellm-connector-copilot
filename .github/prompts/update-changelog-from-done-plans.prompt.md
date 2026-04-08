---
description: "Update CHANGELOG.md from completed plans in .plans/done, using package.json version grouping, then remove processed plan files."
name: "Update changelog from done plans"
argument-hint: "Optional extra notes or exclusions"
agent: "agent"
---
Update this repository's changelog from completed plan files in `./.plans/done`, then remove the processed completed plan files.

Follow this workflow exactly:

1. Read and follow these files before making changes:
   - [AGENTS.md](../../AGENTS.md)
   - [.github/instructions/plan-generation.instructions.md](../instructions/plan-generation.instructions.md)
   - [.github/instructions/typescript-no-any.instructions.md](../instructions/typescript-no-any.instructions.md)
   - [.github/skills/agent-customization/SKILL.md](../skills/agent-customization/SKILL.md)

2. Determine the current version from [package.json](../../package.json).
   - Use the `version` field as the source of truth.
   - If the version contains a `-dev*` suffix, group changelog work under the matching base version section while keeping the active development heading style consistent with the existing changelog.
   - Ignore the `-dev*` suffix when deciding whether a version group already exists.

3. Inspect all completed plan files in `./.plans/done`.
   - Extract only concrete, completed user-facing or internal changes that belong in the changelog.
   - Ignore planning boilerplate, validation steps, rollback steps, required-reading sections, and speculative items that were not clearly completed.
   - De-duplicate overlapping entries across plan files.

4. Update [CHANGELOG.md](../../CHANGELOG.md).
   - Reuse the existing section for the matching version if it already exists.
   - If a similar section or bullet already exists, update it only when the new information is materially different.
   - If an entry is effectively already present, skip it.
   - Preserve the repository's existing heading structure, tone, emoji usage, and ordering.
   - Group related bullets under the most appropriate existing subsection.
   - Prefer concise outcome-focused bullets.

5. After updating the changelog, remove only the completed plan files from `./.plans/done` that were successfully reflected or intentionally deduplicated into the changelog update.
   - Do not remove unrelated files.
   - If a file cannot be confidently reflected, leave it in place and explain why.

6. Validate the result.
   - Re-read the updated changelog and confirm the new section or bullets are present.
   - Confirm the intended completed plan files were removed.
   - Summarize which files contributed new changelog entries, which were deduplicated, and which were left untouched.

Use concise output. Do the work directly rather than returning a plan.
