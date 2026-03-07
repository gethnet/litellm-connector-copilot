---
name: vscode-extension-investigation
description: "Use when validating VS Code extension behavior, implementation, tests, or architecture before coding changes in this repository."
---

# VS Code Extension Investigation

Use this skill when the goal is to verify what exists today before changing code.

## Outcome
Produce an evidence-based assessment of a VS Code extension feature, bug, provider flow, command, adapter, configuration path, or test surface.

The result should:
- confirm what is implemented today
- identify where the behavior lives
- assess whether tests exist and how strong they are
- call out gaps, risks, or doc drift
- recommend the smallest safe next step

## Workflow

### 1. Define the investigation target
Clarify the exact thing being validated:
- feature, command, provider behavior, adapter behavior, config path, or bug
- expected behavior or acceptance criteria
- relevant module, file, or user-facing entry point if known

If the request already contains enough detail, do not ask extra questions.

### 2. Gather evidence from the repository first
Prefer repository evidence in this order:
1. source files and symbol usage
2. targeted tests and fixtures
3. diagnostics and local validation output
4. git history or related issue context
5. documentation, only after checking code

Do not guess. If the repository does not prove a claim, label it unverified.

### 3. Follow the default investigation pass
#### A. Existence
- Search for symbols, commands, provider methods, routes, config keys, or strings.
- Identify the canonical implementation location.

#### B. Behavior
- Trace the flow from entry point to output.
- Note validation, normalization, routing, trimming, feature flags, and error handling.
- Distinguish shared orchestration from protocol-specific behavior.

#### C. Tests
- Find the closest unit, integration, or regression tests.
- Assess whether they actually protect the claimed behavior.
- If useful and feasible, run the smallest relevant validation.

#### D. Gaps and risks
- Note missing tests, ambiguous behavior, duplication, architecture drift, or documentation mismatch.
- Prefer low-risk recommendations that increase confidence before large changes.

### 4. Report with evidence
Structure the result with:
- confirmed findings
- evidence locations
- test coverage and confidence level
- gaps or risks
- recommended next steps

## Decision points

### When to stop and ask
Ask the user only if one of these blocks progress:
- the target behavior is ambiguous
- multiple similarly named features exist and the intended one is unclear
- running a broad or expensive validation would be disproportionate

### When to recommend coding next
Recommend implementation only after the investigation identifies:
- the owning module
- the current behavior
- the relevant tests or the absence of them
- the smallest safe next change

## Completion checks
The investigation is complete only when:
- claims are backed by repository evidence or clearly labeled unverified
- the likely owning files or symbols are identified
- test presence or absence is stated explicitly
- risks and low-risk next steps are summarized clearly

## Example prompts
- Investigate whether the chat provider already handles fragmented tool calls.
- Validate how inline completions choose a model in this extension.
- Check whether the configuration migration path is implemented and tested.
- Investigate whether the shared provider pipeline trims messages before routing.
