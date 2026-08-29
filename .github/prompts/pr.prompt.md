---
description: "Run a full repo-standards code review of a pull request via the PR Reviewer agent. Usage: /pr <GH-PR_NUM>"
name: pr
argument-hint: "<GH-PR_NUM> (GitHub pull request number)"
agent: PR Reviewer
---

Review GitHub pull request **#${input:GH-PR_NUM:pull request number}** in `gethnet/litellm-connector-copilot`.

Follow your full review workflow:

1. Fetch the PR (title, description, changed files, existing review threads, CI status).
2. Diff against the default branch (`main`) and read every changed file with surrounding context.
3. Apply all matching review gates (AGENTS.md non-negotiables, instruction-file conformance, provider architecture, tests & coverage, communication artifacts).
4. Run the full validation suite independently: `npm run compile` → `npm run lint` → `npm run format` → `npm run test:coverage`.
5. Produce the structured review output (verdict, blocking, nits, validation table, unverified, praise).
6. Offer — but do not automatically perform — posting the review to the PR on GitHub.
