---
name: feature-request
description: "Investigate a proposed feature and draft a GitHub feature-request issue ready to file. Use when: requesting a new feature, suggesting an enhancement, drafting a feature issue, writing a GitHub feature request, creating a feature tracking issue."
argument-hint: "Describe the feature or enhancement you want to request"
agent: "agent"
tools: [search, semantic_search, file_search, read_file, list_dir]
---

You are helping draft a high-quality GitHub feature-request issue for this repository.

## Your task

Given the feature idea below, you will:
1. **Investigate** the codebase to understand the current state relevant to the request.
2. **Draft** a complete, well-structured GitHub feature-request issue body aligned to the repository's `feature_request.yml` template.
3. **Optionally file** the issue if the user confirms.

---

## Step 1 — Investigate (read-only)

Before drafting anything, research the current codebase to answer:

- Does any related feature or partial implementation already exist?
  - Search by keywords, symbols, config keys, or file patterns related to the request.
  - Identify the most relevant source files and modules (especially under `src/providers/`, `src/adapters/`, `src/config/`, `src/commands/`).
- What would need to change to implement this feature?
  - Identify the likely owning module(s) based on the architecture described in `AGENTS.md`.
  - Note any shared pipeline stages (base orchestrator, adapters, registry) that would be affected.
- Are there any existing tests covering related behavior?
- Are there related open issues, PRs, or TODO comments in the codebase?

Summarize your findings in a short **Investigation Summary** section before the draft issue.

---

## Step 2 — Draft the GitHub Issue

Using the investigation findings, produce a complete issue body following the structure below.
Match the labels from [`.github/ISSUE_TEMPLATE/feature_request.yml`](./../ISSUE_TEMPLATE/feature_request.yml).

### Issue structure

```
**Title**: [Feature]: <concise, outcome-focused description>
```

**Body sections:**

#### 🚀 Feature / Enhancement Suggestion
_A clear, 1–3 sentence description of what you want and why it would be valuable._

#### 🎯 Motivation / Problem It Solves
_What user pain, limitation, or workflow gap does this address?_
_Include concrete examples of the current friction._

#### 💡 Proposed Solution
_Describe the desired behavior. Be specific:_
- What should happen that doesn't happen today?
- What API / UI / config surface would change?
- Any preferred implementation approach?

#### 🔍 Current State (from Investigation)
_Summarize what exists today that is relevant:_
- Related files / modules found
- Partial implementations or workarounds
- Existing tests that would be affected

#### 📐 Acceptance Criteria
_A checklist of conditions that must be true for this feature to be considered complete:_
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Tests added / updated (unit + integration where applicable)

#### 🔗 Related
_Links to related issues, PRs, external docs, or code locations (file paths + symbols)._

---

## Step 3 — File the issue (optional)

After presenting the draft, ask the user:
> "Would you like me to file this as a GitHub issue now, or do you want to refine it first?"

If they confirm, use the `github-pull-request_create_issue` tool (or equivalent) to file the issue with:
- Title as drafted
- Body as drafted
- Labels: `status:new`, `type:feat-req`

---

## Quality criteria

- **Actionable**: A maintainer reading this should immediately understand what to build and why.
- **Grounded**: Claims about current state must be backed by actual code found in Step 1.
- **Scoped**: The acceptance criteria should be completable in a single PR.
- **Clean**: Proper Markdown formatting; no filler prose; no duplicated sections.

---

## Feature request input

{{$input}}
