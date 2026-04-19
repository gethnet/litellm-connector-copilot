---
description: "Update both README files from the repository state at the time of request"
name: "Update READMEs from repo state"
argument-hint: "Optional notes, exclusions, or emphasis"
agent: "agent"
---
Update both README files in this repository based on the current state of the workspace at the time this prompt is run.

Follow this workflow:

0. Read [AGENTS.md](../../AGENTS.md) before continuing.

1. Review the repository state first.
   - Inspect the current codebase structure, configuration, package metadata, and any existing README content.
   - Use the repository as the source of truth for features, commands, setup steps, architecture, and file layout.
   - If the workspace state has changed since the last edit, reflect the latest state rather than stale docs.

2. Update both readme files.
   - Edit [README.md](../../README.md) and [README.marketplace.md](../../README.marketplace.md).
   - Keep the two files aligned where they overlap, but tailor each one to its audience and purpose.
   - Preserve useful existing content unless it is outdated or contradicted by the repository state.
   - Add, remove, or revise sections so the docs accurately describe the current project.

3. Prefer factual, repo-derived content.
   - Use package scripts, source files, configuration, and existing conventions as the source of truth.
   - Avoid claiming features, commands, or setup steps that are not supported by the repository.
   - If the repo state is ambiguous, choose the most conservative wording.

4. Keep the writing concise and current.
   - Match the repository's tone and formatting.
   - Update examples, commands, links, and architecture notes when they no longer match reality.
   - Avoid duplicating the same information unnecessarily across sections.

5. Validate the result.
   - Re-read both README files after editing.
   - Confirm the final content reflects the current repository state.
   - Summarize the material changes made to each file.

If the repository state does not support a confident update to a section, leave that section unchanged and note the uncertainty.
