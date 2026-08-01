---
description: "Finish a dev version cycle: promote the -devN version to a release version, update CHANGELOG and README release notes, run the validation gate, and open a release PR to main."
name: "Finish dev version"
argument-hint: "Optional: release notes emphasis or exclusions"
agent: "agent"
---

Finish the current development cycle and prepare this branch for release. Promote the `-devN` pre-release version to its final release version, bring all release documentation up to date, validate everything, and open a release PR to `main`.

Follow this workflow exactly:

1. Read and follow [AGENTS.md](../../AGENTS.md) before making changes. Only use the permitted npm commands it lists.

2. Confirm preconditions.
   - The current branch must NOT be `main`. If it is, stop and tell the user to run this from a dev branch.
   - Read the `version` field in [package.json](../../package.json). It should carry a `-devN` suffix; if it does not, ask the user whether the version was already promoted before continuing.
   - Run `git status --short`; note any uncommitted changes and include them in the final summary.

3. Promote the version.
   - Strip the `-devN` suffix by editing `package.json` directly (e.g. `2.3.0-dev4` → `2.3.0`). Do NOT run `npm run bump-version` — the base version was already chosen when the dev cycle started; this step only removes the pre-release suffix.
   - Sync `package-lock.json`: update the top-level `version` and the `packages[""].version` fields to match.

4. Update [CHANGELOG.md](../../CHANGELOG.md).
   - Promote the `## [Unreleased]` section to `## [<version>] - <today's date>`.
   - Insert a fresh empty `## [Unreleased]` heading above it.
   - Verify every notable change on this branch (vs `origin/main`) is represented; add missing entries following the existing tone, emoji usage, and subsection structure. Use `git log --oneline origin/main..HEAD` and `git diff --stat origin/main..HEAD` to cross-check.
   - Update the footer `[Unreleased]` link reference to compare from `rel/v<version>...HEAD`.
   - Update any stale "Version bump" chore bullet to reflect the final version.

5. Update the "What's New" sections.
   - Both [README.md](../../README.md) and [README.marketplace.md](../../README.marketplace.md) have a `## 🆕 What's New in <previous-version>` section near the top.
   - Rewrite each as `## 🆕 What's New in <version>` with 2–4 outcome-focused bullets summarizing the user-facing highlights of this release. Keep the existing structure (blockquote summary line, bullets, CHANGELOG link).

6. Run the full validation gate, each independently, and confirm each succeeds:
   - `npm run compile`
   - `npm run lint`
   - `npm run format`
   - `npm run test:coverage`

7. Verify version consistency.
   - `package.json`, `package-lock.json`, the CHANGELOG heading, and both README "What's New" headings must all show the same `<version>` with no `-devN` remnants anywhere. Search the repo for the old dev version string to be sure.

8. Commit and open the release PR.
   - Commit all release-prep changes with an emoji-prefixed, outcome-focused message (e.g. `🚀 Release v<version> — <short highlight>`), then push the branch.
   - Open a PR targeting `main` following the PR template (`.github/PULL_REQUEST_TEMPLATE/common_pr.yml`): a Change Log / Overview grouped by category, related issues, and the pre-check checklist with the validation summary.
   - Do NOT merge the PR, tag, or publish — the user squash-merges from the web UI, then tags `rel/v<version>` on `main` to trigger the release pipeline.

9. Summarize.
   - Report: old version → new version, files changed, validation results, and the PR URL.
   - Remind the user of the remaining manual steps: squash-merge via web UI, then `git checkout main && git pull && git tag rel/v<version> && git push origin rel/v<version>`.
