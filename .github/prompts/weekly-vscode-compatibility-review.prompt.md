---
name: weekly-vscode-compatibility-review
description: "Review weekly VS Code releases and upstream changes for compatibility risks affecting the LiteLLM Connector for GitHub Copilot extension."
argument-hint: "Optional previous review date, VS Code tag, commit, or specific area to emphasize"
---
You are performing the weekly VS Code compatibility maintenance review for the `gethnet/litellm-connector-copilot` extension.

The purpose of this review is to identify upstream VS Code changes early so that weekly releases do not introduce unexpected compatibility problems.

## Repositories

Extension repository:
- https://github.com/gethnet/litellm-connector-copilot

VS Code repository:
- https://github.com/microsoft/vscode

Extension details:
- Current branch: `main`
- VS Code engine target: `^1.120.0`
- Extension type: VS Code Language Model provider for LiteLLM and GitHub Copilot

## Review Window

Review all relevant changes merged or released since:

- Previous review date: `[INSERT LAST REVIEW DATE]`
- Previous reviewed VS Code commit or tag: `[INSERT LAST REVIEWED COMMIT OR TAG]`

If the previous review point is unavailable, use the last seven calendar days and clearly state that limitation. Use any user-provided input after this prompt as the authoritative review-window override.

## Primary Objective

Determine whether anything in the latest VS Code weekly release cycle could affect the extension’s:

- Build or TypeScript compatibility
- Runtime behavior
- Language Model API integration
- Chat provider implementation
- Model discovery or model picker behavior
- Streaming responses
- Tool calls and tool results
- Reasoning/thinking parts
- Inline completions
- Provider-group configuration
- Secret handling
- Extension activation
- Proposed API declarations
- Telemetry or logging
- Tests and CI validation
- Published extension compatibility or marketplace behavior

## Extension Areas to Inspect

Compare upstream changes against the current implementation, especially:

- `package.json`
- `src/extension.ts`
- `src/providers/`
- `src/adapters/`
- `src/config/`
- `src/telemetry/`
- `src/observability/`
- `src/vscode.d.ts`
- `src/vscode.proposed.*.d.ts`
- `src/test/`
- `AGENTS.md`

Pay particular attention to:

- `vscode.LanguageModelChatProvider`
- `vscode.lm.registerLanguageModelChatProvider`
- `languageModelChatProviders`
- per-group provider configuration
- `LanguageModelChatInformation`
- model picker metadata
- `isUserSelectable`
- model categories and ordering
- reasoning-effort configuration
- chat response parts
- tool-call streaming
- tool-result handling
- inline-completions routing
- proposed VS Code APIs
- extension-host behavior
- SecretStorage and configuration APIs

## Upstream Sources

Use the strongest available evidence, prioritizing:

1. VS Code release notes.
2. Official VS Code API documentation.
3. VS Code API declaration changes.
4. Relevant VS Code commits and pull requests.
5. Changes under:
   - `src/vs/workbench/api`
   - `src/vs/workbench/contrib`
   - `src/vscode-dts`
   - extension contribution-point validation
6. Relevant GitHub issues and discussions.

Do not report unrelated internal changes unless they can affect extension APIs, extension-host behavior, performance, security, or marketplace compatibility.

## Required Analysis

For every relevant change, determine whether it is:

- Confirmed impact
- Probable impact
- Possible future risk
- No meaningful impact

For each finding, include:

- Severity: Critical, High, Medium, Low, or Informational
- Upstream version, release, commit, PR, issue, or date
- Direct source URL
- What changed
- Why it matters to this extension
- Affected extension files, APIs, classes, or tests
- Recommended action
- Whether the action is:
  - Immediate code change
  - Regression test
  - Documentation update
  - CI/build validation
  - Monitoring only
  - No action required
- Confidence level

## Maintenance-Cycle Checks

Explicitly check for missed maintenance risks:

- New deprecations or API removals
- Proposed APIs becoming stable, changing shape, or being withdrawn
- New required properties or changed defaults
- Changed contribution-point schemas
- Changes to model picker behavior
- Changes to streaming or tool-call semantics
- Changes to extension activation or lifecycle behavior
- Changes to extension-host performance or memory behavior
- Changes affecting SecretStorage or configuration isolation
- Changes that could make the current VS Code engine range inaccurate
- Changes that require updates to `src/vscode.d.ts` or proposed declaration files
- Open upstream issues that could affect this extension soon
- Changes that were easy to miss because they were not prominently documented in release notes

## Output Format

# Weekly VS Code Compatibility Review

## Review Metadata

Include:

- Review date
- Review window
- Last reviewed commit or tag
- Latest VS Code release or commit reviewed
- Sources checked
- Any limitations

## Executive Summary

Summarize:

- Overall compatibility status
- Whether immediate action is required
- The three most important findings
- Whether the extension appears safe for the next weekly VS Code release

## Immediate Actions

List only items that should be addressed before the next maintenance cycle.

Use:

| Priority | Area | Action | Affected Files | Reason | Evidence |
|---|---|---|---|---|---|

If there are no immediate actions, state that explicitly.

## Relevant Upstream Changes

Use:

| Severity | Area | Upstream Change | Extension Impact | Recommended Action | Confidence | Evidence |
|---|---|---|---|---|---|---|

## API and Behavior Review

Cover:

- Language Model APIs
- Chat providers
- Streaming and response parts
- Tool calls and tool results
- Reasoning/thinking support
- Model picker behavior
- Provider configuration
- Inline completions
- Proposed APIs
- Extension lifecycle
- Security and secrets
- Performance and extension-host behavior

For each area, state one of:

- No relevant change found
- Change found — no current impact
- Change found — monitoring required
- Change found — action required

## Extension File Impact Map

Map each finding to concrete files and symbols in this repository.

| Finding | File | Symbol or Configuration | Impact | Suggested Validation |
|---|---|---|---|---|

## Recommended Maintenance Backlog

Group work into:

### Do Now

Issues that could affect current users or the next release.

### Do Before the Next Engine Update

Issues that are not immediately breaking but should be addressed before raising the VS Code engine target.

### Monitor

Upstream changes or proposals that may become relevant.

### No Action Required

Reviewed areas with no meaningful impact.

## Compatibility Matrix

| VS Code Version or Release | Status | Findings | Required Action |
|---|---|---|---|

Include the current engine target and the latest weekly release.

## Validation Plan

Recommend specific repository-approved validation, such as:

- `npm run compile`
- `npm run lint`
- `npm run format`
- `npm run test:coverage`

Only recommend commands that are relevant to the findings.

## Missed-Change Risk Assessment

Answer:

1. What could have been missed during the previous maintenance cycle?
2. Which upstream areas deserve extra attention next week?
3. Are there any changes that are poorly documented or still evolving?
4. What single action would most reduce compatibility risk?

## Final Assessment

Provide:

- Overall risk: Low, Medium, High, or Critical
- Release readiness: Ready, Ready with monitoring, Action required, or Blocked
- A concise explanation
- The recommended date or trigger for the next review

## Review Rules

- Compare against the previous review point; do not repeatedly report old findings.
- Focus on changes introduced during the review window.
- Inspect actual diffs where possible, not only commit titles.
- Cite every material claim.
- Clearly distinguish facts from assumptions.
- Do not recommend code changes without identifying the affected extension behavior.
- Do not make changes to the repository unless explicitly asked.
- If no noteworthy changes are found, say so clearly and provide the areas that were checked.
