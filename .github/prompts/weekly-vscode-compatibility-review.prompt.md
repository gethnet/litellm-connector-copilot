---
name: weekly-vscode-compatibility-review
description: "Weekly VS Code compatibility review for the LiteLLM Connector extension. Covers Stable AND Insiders (commit-driven, no release notes), always writes a Week-Review_MMDDYYYY.md report to disk, and proposes feature/improvement opportunities aligned with upstream VS Code changes."
argument-hint: "Optional: previous review date, VS Code tag/commit, track (stable|insiders|both), or an area to emphasize"
agent: "agent"
---
You are performing the weekly VS Code compatibility maintenance review for the `gethnet/litellm-connector-copilot` extension.

The review has three mandatory outcomes, in priority order:

1. **Detect compatibility risk early** so weekly VS Code Stable and daily Insiders builds do not break the extension.
2. **Always produce a written report on disk**, even when nothing changed, when evidence is incomplete, or when the review is interrupted.
3. **Surface opportunities**: propose features and improvements the extension should adopt because of what VS Code shipped or is about to ship.

Use any user-provided input after this prompt as the authoritative override for review window, track, or emphasis.

---

## 1. Repositories and Extension Facts

Extension repository:
- https://github.com/gethnet/litellm-connector-copilot
- Working copy: the current workspace. Report the checked-out branch and HEAD commit (`git rev-parse --short HEAD`, `git branch --show-current`).
- Extension type: VS Code Language Model chat provider for LiteLLM, consumed by GitHub Copilot Chat.

VS Code repository:
- https://github.com/microsoft/vscode

**Authoritative extension facts — read them from disk, do not trust this prompt's memory:**

| Fact | Source of truth |
|---|---|
| Engine target | `package.json` → `engines.vscode` (currently `^1.125.0`; re-read every run) |
| Enabled proposed APIs | `package.json` → `enabledApiProposals` (8 proposals: `chatProvider`, `languageModelCapabilities`, `languageModelPricing`, `languageModelProxy`, `languageModelSystem`, `languageModelThinkingPart`, `languageModelToolResultAudience`, `languageModelToolSupportsModel`) |
| Vendored API declarations | `src/vscode.d.ts` + `src/vscode.proposed.*.d.ts` (9 files). Refreshed by `npm run download-api` (`dts main` / `dts dev`), which runs on `postinstall`. |
| Contribution points | `package.json` → `contributes.languageModelChatProviders`, `contributes.commands`, `contributes.configuration`, `contributes.menus` |
| Architecture map | `AGENTS.md` §4 |
| Previous reports | `Week-Review_*.md` at the repository root |

---

## 2. Review Window and Track Selection

### Determine the previous review point

In order of preference:

1. The user-supplied date / tag / commit.
2. The newest `Week-Review_MMDDYYYY.md` at the repo root — read its **Review Metadata** table for "Latest stable", "Latest Insiders commit", and "Local API declarations" values and use those as the baseline.
3. If neither exists: the last seven calendar days. State this limitation explicitly in the report.

### Determine which tracks to review

Review **both** tracks unless the user restricts to one:

| Track | What "latest" means | Primary evidence |
|---|---|---|
| **Stable** | Newest `1.NNN.x` tag on `microsoft/vscode` (`gh release list --repo microsoft/vscode --limit 5`, or the GitHub releases page) | Release notes (`https://code.visualstudio.com/updates/v1_NNN`), tag-to-tag diff, PRs in the milestone |
| **Insiders** | HEAD of `main` on `microsoft/vscode` at review time (Insiders builds nightly from `main`). Record the exact SHA and its commit date. | **Git commits and diffs only** — see §3. |

Record both the previous and the new review point for each track so the next run can resume from them.

---

## 3. Insiders Track Procedure (commit-driven — no release notes exist)

The Insiders build has no reliable release notes. The `code.visualstudio.com/updates/v1_NNN` page for the in-progress milestone is often days behind `main`, incomplete, and may be rewritten before the stable release. **Treat it as a hint, never as evidence.** Insiders findings must be backed by a commit SHA, a merged PR, or a diff.

Follow this procedure:

### 3.1 Enumerate commits in the window on the paths that matter

Use the GitHub CLI or API to list commits between the previous Insiders SHA and current `main` HEAD, scoped to the paths this extension depends on. Use path-scoped history rather than date-filtered search (the commit-search index lags and returns empty results for recent windows):

```bash
# Repeat per path; use --until/--since as a fallback when the previous SHA is unknown.
gh api "repos/microsoft/vscode/commits?path=src/vscode-dts&sha=main&since=<ISO-DATE>" --jq '.[] | "\(.sha[0:8]) \(.commit.author.date[0:10]) \(.commit.message | split("\n")[0])"'
```

Paths to enumerate (minimum):

- `src/vscode-dts/vscode.d.ts`
- `src/vscode-dts/vscode.proposed.chatProvider.d.ts` and every other `vscode.proposed.*.d.ts` listed in `enabledApiProposals`
- `src/vs/workbench/api/common/extHostLanguageModels.ts`
- `src/vs/workbench/api/browser/mainThreadLanguageModels.ts`
- `src/vs/workbench/api/common/extHostTypeConverters.ts` (LM part conversions)
- `src/vs/workbench/api/common/extHostTypes.ts` (LanguageModel* classes)
- `src/vs/workbench/api/common/extHostSecrets.ts` and `src/vs/workbench/api/common/extHostConfiguration.ts`
- `src/vs/workbench/contrib/chat/` (model picker, language-model service, BYOK/provider-group configuration UI — locate the current file names each run; they move)
- `src/vs/editor/contrib/inlineCompletions/`
- `src/vs/workbench/services/extensions/` (extension host lifecycle, activation, API proposal gating)
- `src/vs/platform/extensionManagement/` (contribution-point validation, marketplace/gallery behavior)
- `extensions/*/package.json` schema changes for `languageModelChatProviders` if present

If a previously known path 404s, locate its successor (`gh api "repos/microsoft/vscode/contents/<parent>"`), record the move in the report's Limitations, and continue.

### 3.2 Verify vendored declaration drift by blob SHA

For each of the 9 local `src/vscode*.d.ts` files, compare against upstream `main`:

```bash
git hash-object src/vscode.proposed.chatProvider.d.ts
gh api "repos/microsoft/vscode/contents/src/vscode-dts/vscode.proposed.chatProvider.d.ts?ref=main" --jq '.sha'
```

- **Match** → no drift; say so per file.
- **Mismatch** → fetch the upstream file, diff it against the local copy, and classify every changed symbol (added / removed / signature change / doc-only). A mismatch is at least a **Medium** finding until proven doc-only, because `npm run download-api` runs on `postinstall` and will silently pull the new shape into the next CI build.

Also check whether any proposal in `enabledApiProposals` was **finalized** (moved into `vscode.d.ts`), **renamed**, **versioned** (`// version: N` header bump), or **deleted** upstream. Any of these breaks compile or activation.

### 3.3 Inspect diffs, not titles

For every commit surfaced in 3.1 that touches a public type, event, contribution-point schema, or runtime behavior on the LM/chat path, read the actual diff (`gh api repos/microsoft/vscode/commits/<sha>` → `files[].patch`, or the PR "Files changed" view). Commit titles are insufficient evidence.

### 3.4 Correlate with issues and PRs

- Read the linked PR for each material commit; note milestone, labels, and whether it was reverted later in the window.
- Search issues opened in the window with `gh search issues --repo microsoft/vscode --created ">=<DATE>" "language model" OR "chatProvider" OR "BYOK" OR "model picker"` and read the ones touching provider extensions.
- Check the next two milestones for open PRs that would change the surfaces above; these become **Monitor** or **Opportunity** items.

### 3.5 Stable-track cross-check

When a Stable release lands in the window, confirm which Insiders commits it actually contains (`gh api repos/microsoft/vscode/compare/<prev-tag>...<new-tag>`). A change seen on `main` may or may not be in the stable release; say which.

---

## 4. Compatibility Analysis

### 4.1 Extension areas to compare against upstream

- `package.json` (engine, proposals, `languageModelChatProviders` schema, commands, menus, `when` clauses)
- `src/extension.ts` — activation, provider registration, dev-build context key
- `src/providers/` — `LiteLLMProviderBase`, `LiteLLMChatProvider`, `LiteLLMCommitMessageProvider`, `LiteLLMProviderRegistry`
- `src/adapters/` — `litellmClient.ts`, `responsesAdapter.ts`, `streaming/`, `sse/`, `tokenUtils.ts`
- `src/config/` — `configManager.ts`, `legacyConfigMigration.ts`
- `src/commands/` — model picker, config management, dev tools
- `src/telemetry/`, `src/observability/`
- `src/vscode.d.ts`, `src/vscode.proposed.*.d.ts`
- `src/test/` and co-located `**/test/` suites
- `AGENTS.md` — architecture notes that may need updating

### 4.2 Symbols and behaviors to scrutinize

- `vscode.LanguageModelChatProvider`, `vscode.lm.registerLanguageModelChatProvider`
- `LanguageModelChatInformation` — `isUserSelectable`, `category` (`label`/`order`), `detail`, `tooltip`, pricing fields (`inputCost`, `outputCost`, `cacheCost`, `cacheWriteCost`, `priceCategory`), `configurationSchema` (esp. `reasoningEffort` with `group: "navigation"`), `capabilities`, tags such as `inline-completions`
- `provideLanguageModelChatInformation` / `provideLanguageModelChatResponse` / `provideTokenCount` signatures and `options.configuration` (per-group config)
- `onDidChangeLanguageModelChatInformation` semantics
- Response parts: `LanguageModelTextPart`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart`, `LanguageModelThinkingPart`, `LanguageModelDataPart` (usage payload shape)
- Tool-call streaming, tool-result audience, `supportsModel` on tools
- Inline-completions tag routing through the chat provider
- Contribution point `languageModelChatProviders` schema and `"secret": true` handling
- `SecretStorage`, `globalState`, configuration isolation
- Extension activation events, API proposal gating, extension-host memory/perf changes
- Marketplace / gallery behavior affecting publishing (`@vscode/vsce`, signing, engine validation)

### 4.3 Classification required for every finding

- Impact class: **Confirmed**, **Probable**, **Possible future risk**, **No meaningful impact**
- Severity: **Critical**, **High**, **Medium**, **Low**, **Informational**
- Track: **Stable**, **Insiders**, or **Both**
- Evidence: version/tag, commit SHA, PR/issue number, date, and a direct URL
- What changed; why it matters here; affected files/symbols/tests
- Recommended action type: Immediate code change · Regression test · Documentation update · CI/build validation · Monitoring only · No action required
- Confidence: High / Medium / Low, with the reason for anything below High

### 4.4 Maintenance-cycle checks (answer each explicitly)

- New deprecations or API removals
- Proposed APIs finalized, reshaped, versioned, renamed, or withdrawn
- New required properties or changed defaults on `LanguageModelChatInformation` or provider options
- Changed contribution-point schemas or validation rules
- Model picker behavior changes (grouping, ordering, visibility, pricing display, effort selector)
- Streaming, tool-call, or tool-result semantic changes
- Activation / lifecycle / API-gating changes
- Extension-host performance or memory changes
- SecretStorage or configuration-isolation changes
- Anything that makes the current `engines.vscode` range inaccurate
- Anything requiring `npm run download-api` or manual edits to `src/vscode*.d.ts`
- Open upstream issues likely to affect this extension within two cycles
- Changes not (or poorly) documented in release notes — Insiders findings will almost always be in this bucket

---

## 5. Opportunity Assessment (features and improvements)

Compatibility is defensive; this section is offensive. For every upstream change in the window — plus open PRs in the next two milestones — ask: **"Could the LiteLLM Connector be better because of this?"**

Consider, at minimum:

- **New or expanded LM API surface** (stable or proposed) the extension does not yet use: new `LanguageModelChatInformation` fields, new response part types, new capability flags, new tool metadata, new provider options.
- **Model picker enhancements**: new metadata slots (detail, tooltip, badges, pricing, categories, ordering, per-model settings) that could expose LiteLLM data (`/model/info`, pricing, context window, mode) more richly.
- **Reasoning / thinking**: new effort levels, summary controls, redacted-reasoning parts, thinking-continuity helpers that map to Anthropic/OpenAI reasoning semantics the `/responses` adapter already handles.
- **Tool calling**: streaming improvements, parallel tool calls, tool-result audience, `supportsModel`, structured tool errors.
- **Inline completions / next-edit-suggestions**: routing or capability changes that would let LiteLLM-backed models serve more Copilot surfaces.
- **Configuration & secrets**: new per-group configuration schema features (enums, secret fields, validation, UI hints) that could replace bespoke commands in `src/commands/`.
- **Telemetry / observability hooks**: new host-provided usage, latency, or cache metrics that could replace or enrich `StreamTokenCapture` / `TelemetryService` data.
- **Performance**: host-side caching, debouncing, or lazy-activation features that could simplify `LiteLLMProviderRegistry`'s discovery cache and debounce logic.
- **Proposals nearing finalization**: a proposal in `enabledApiProposals` moving to stable means the extension could drop the proposal flag, widen marketplace compatibility, or raise `engines.vscode` deliberately.
- **Copilot Chat behavior changes** (agent mode, subagents, autopilot, prompt structure) that change what messages the provider receives and therefore what the connector should normalize, trim, or cache-optimize.

For each opportunity produce:

| Field | Requirement |
|---|---|
| Title | Outcome-focused, 1–2 emojis per AGENTS.md communication style |
| Upstream trigger | Commit / PR / release note with URL and track |
| Availability | Stable in `1.NNN` · Insiders-only · Proposed (name + version) · Open PR (milestone) |
| User value | What a LiteLLM user gains |
| Extension touch points | Concrete files/symbols to change (e.g. `src/providers/liteLLMProviderRegistry.ts::toVSCodeInfo`) |
| Effort | S / M / L with one-line justification |
| Prerequisites | Engine bump? New proposal flag? `download-api` refresh? Depends on another finding? |
| Recommendation | **Propose now** (open a `type:feature` / `type:enhancement` issue) · **Plan for next engine bump** · **Prototype on Insiders** · **Defer / watch** |
| Risk if ignored | Competitive gap, degraded UX, future forced migration, or "none" |

Rank opportunities by value ÷ effort. Include at least one entry even in quiet weeks (a "no material opportunity this week; nearest candidate is …" row is acceptable), so the section never silently disappears.

Do **not** open issues or create plans automatically; recommend them. The user decides.

---

## 6. Report Output — Always Written to Disk

### 6.1 File location and naming

- Path: repository root
- Name: `Week-Review_MMDDYYYY.md` using the **review date** (e.g. `Week-Review_09172026.md`). Match the existing convention exactly; prior reports live beside it.
- If a file for today already exists, do not overwrite silently — write `Week-Review_MMDDYYYY-2.md` and mention the prior file in Review Metadata.
- These files are gitignored (`*.md` root rule) — they are local artifacts and must **not** be committed. Say so at the end of the chat response.

### 6.2 Non-negotiable write behavior

- **Write the report file before composing the final chat response.** The chat response is a summary that points at the file; the file is the deliverable.
- **Write even when there are zero findings.** A quiet week is a result: enumerate exactly what was checked (paths, SHAs, tags, blob-SHA matches) so the next run can trust it as a baseline.
- **Write even when the review is partial.** If evidence retrieval fails (API rate limits, 404s, tool errors), write the report with a `## Limitations and Gaps` section listing what could not be verified and what to retry, and set Release readiness to at most **Ready with monitoring**.
- Write the full file in a single create operation once analysis is complete; do not leave a half-written stub if the session ends early — if you must checkpoint, write a complete-but-short report and expand it afterward.
- After writing, re-read the file (or `wc -l` + `head`) to confirm it exists and is non-empty.

### 6.3 Report structure (exact heading order)

```markdown
# Weekly VS Code Compatibility Review

## Review Metadata
| Item | Result |
|---|---|
| Review date | YYYY-MM-DD |
| Tracks reviewed | Stable / Insiders / Both |
| Review window | <start> → <end>, and how the window was determined |
| Previous review point | Stable tag + Insiders SHA (+ file name of the prior report) |
| Latest Stable reviewed | 1.NNN.x, release date, tag SHA, release-notes URL |
| Latest Insiders reviewed | `main` @ <SHA> (commit date) |
| Extension revision | branch @ short SHA; `engines.vscode`; version from package.json |
| Local API declarations | Per-file MATCH / DRIFT vs upstream main (blob SHA) |
| Sources checked | Bullet list: paths enumerated, releases, diffs, issues, milestones |
| Limitations | Anything not verifiable, moved paths, index lag, rate limits |

## Executive Summary
- Overall compatibility status (one sentence, bold)
- Immediate action required? (Yes/No)
- Three most important findings (compat or opportunity), each with severity/track/URL
- Safe for the next Stable release? Safe on current Insiders?

## Immediate Actions
| Priority | Track | Area | Action | Affected Files | Reason | Evidence |
|---|---|---|---|---|---|---|
(State "None" explicitly if empty.)

## Relevant Upstream Changes
| Severity | Track | Area | Upstream Change | Extension Impact | Recommended Action | Confidence | Evidence |
|---|---|---|---|---|---|---|---|

## Insiders Commit Digest
| SHA | Date | Path | Summary | Relevance | Diff inspected? |
|---|---|---|---|---|---|
(Every commit enumerated in §3.1, including "not relevant" rows — this is the audit trail for the next run.)

## API and Behavior Review
One line per area (Language Model APIs · Chat providers · Streaming & response parts · Tool calls & results · Reasoning/thinking · Model picker · Provider configuration · Inline completions · Proposed APIs · Extension lifecycle · Security & secrets · Performance & extension host · Marketplace/publishing), each marked:
No relevant change found · Change found — no current impact · Change found — monitoring required · Change found — action required

## Extension File Impact Map
| Finding | File | Symbol or Configuration | Impact | Suggested Validation |
|---|---|---|---|---|

## Opportunity Assessment
Ranked table using the §5 fields, followed by a short paragraph per "Propose now" item with a draft issue title and 3–5 bullet acceptance criteria.

## Recommended Maintenance Backlog
### Do Now
### Do Before the Next Engine Update
### Prototype on Insiders
### Monitor
### No Action Required

## Compatibility Matrix
| VS Code Version / Build | Track | Status | Findings | Required Action |
|---|---|---|---|---|
(Include: current engine minimum, latest Stable, latest Insiders `main` SHA.)

## Validation Plan
Only repository-approved commands relevant to the findings:
`npm run compile` · `npm run lint` · `npm run format` · `npm run test:coverage` · `npm run download-api` (only when declaration drift was found — note it rewrites `src/vscode*.d.ts`).
State what each command is expected to prove.

## Missed-Change Risk Assessment
1. What could have been missed during the previous cycle?
2. Which upstream paths deserve extra attention next week?
3. Which changes are poorly documented or still evolving (Insiders-only, open PRs)?
4. What single action would most reduce compatibility risk?

## Limitations and Gaps
(Always present. "None" is acceptable only if every §3.1 path and every d.ts file was verified.)

## Final Assessment
- Overall risk: Low / Medium / High / Critical
- Release readiness: Ready / Ready with monitoring / Action required / Blocked
- Concise explanation (Stable and Insiders separately if they differ)
- Next review: recommended date **and** triggers (e.g. "or immediately if `vscode.proposed.chatProvider.d.ts` changes on main")
- Baseline for next run: Stable tag + Insiders SHA + report filename
```

### 6.4 Final chat response

After the file is written and verified, reply in chat with:

1. The report path.
2. Overall risk + release readiness for each track.
3. The Immediate Actions table (or "None").
4. The top-ranked opportunity in one sentence.
5. A reminder that `Week-Review_*.md` is gitignored and should not be committed.

Keep it short — the detail lives in the file.

---

## 7. Review Rules

- Compare against the previous review point; do not re-report old findings except to update their status (fixed upstream / still open / escalated).
- Focus on changes introduced during the window; carry-over items go in **Monitor** with a "carried since <date>" note.
- Inspect actual diffs where possible, not commit titles or release-note prose.
- Insiders claims require a commit SHA or merged PR; release-note prose alone is insufficient for the Insiders track.
- Cite every material claim with a direct URL.
- Clearly distinguish facts from assumptions and label confidence.
- Do not recommend code changes without naming the affected extension behavior, file, and symbol.
- Do not modify repository source, `package.json`, tests, or `AGENTS.md`. The only file this prompt may create is the `Week-Review_MMDDYYYY.md` report.
- Do not run `npm run download-api` during the review; recommend it in the Validation Plan if drift was found.
- If no noteworthy changes are found, say so clearly, list everything checked, and still write the report.
- Prefer `gh` CLI / GitHub API and direct file fetches over web search summaries; use web search only to locate sources, then verify them directly.
