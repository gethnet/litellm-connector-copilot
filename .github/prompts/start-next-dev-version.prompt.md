---
description: "Start development on the next version: carry current workspace changes onto a new dev branch, then bump the version with the requested variant."
name: "Start next dev version"
argument-hint: "Optional: variant (major|minor|patch|dev) and/or a branch topic, e.g. 'minor reasoning-overhaul'"
agent: "agent"
---

Start development on the next version of this extension. Carry any current local workspace changes onto a new dev branch, then bump the version.

Follow this workflow exactly:

1. Read and follow [AGENTS.md](../../AGENTS.md) before making changes. Only use the permitted npm commands it lists.

2. Determine the version variant.
   - Acceptable variants: `major`, `minor`, `patch`, `dev`.
   - If the user supplied a variant in their request, use it.
   - Otherwise, infer from context (e.g. the conversation or pending changes imply a feature → `minor`, a fix → `patch`).
   - If nothing is implied, default to `dev`.
   - Variant semantics (for reference):
     - `major`: increments major, resets minor and patch to `0`, clears any `-devN` suffix unless `dev` is also passed.
     - `minor`: increments minor, resets patch to `0`, clears `-devN` unless `dev` is also passed.
     - `patch`: increments patch, clears `-devN` unless `dev` is also passed.
     - `dev`: appends `-dev1` if missing, otherwise increments the `-devN` counter.

3. Determine the dev branch name.
   - If the user supplied a topic or branch name, use `dev/<topic>` (kebab-case).
   - Otherwise, infer a short topic from the current changes or conversation context (e.g. `dev/byok-docs`, `dev/stale-policy`).
   - If nothing is inferable, use `dev/next-<base-version>` where `<base-version>` is the version that will result from the bump (without the `-devN` suffix).
   - Never reuse an existing branch name; check with `git branch --list` and append a numeric suffix if needed.

4. Create the dev branch, carrying current changes.
   - Run `git status --short` to record the current working-tree state.
   - Ensure the current branch is up to date enough to branch from (do NOT pull or rebase automatically; branch from the current state as-is).
   - Run `git switch -c <branch-name>`. Uncommitted changes travel with the switch automatically — do NOT stash, reset, or discard anything.
   - Verify with `git branch --show-current` and confirm `git status --short` still lists the same changes.

5. Bump the version on the new branch.
   - Run `npm run bump-version <variant> dev` (always include the trailing `dev` so the new cycle starts as a `-dev1` pre-release, unless the user explicitly asked for a non-dev version).
   - Note: the script is `bump-version` (hyphen), not `bump:version`.
   - Verify the new version in [package.json](../../package.json) matches the expected result and includes a `-devN` suffix when `dev` was requested.
   - If `package-lock.json` did not update automatically, sync it by updating its top-level `version` fields to match.

6. Validate and summarize.
   - Confirm the branch name, old version, and new version.
   - Confirm all pre-existing workspace changes are still present and untouched.
   - Do NOT commit or push unless the user explicitly asks.
   - Summarize: branch created, version bump applied (old → new), and any files carried over.
