---
name: vscode-extension-implementation
description: "Use when implementing or refactoring VS Code extension features in this repository with a TDD-first workflow, modular architecture, and full validation."
---

# VS Code Extension Implementation

Use this skill for repository work that changes VS Code extension behavior, provider orchestration, commands, adapters, configuration flow, or related tests.

## Outcome
Produce a validated implementation that:
- starts with tests when behavior changes
- keeps code modular, simple, and logically placed
- aligns with repository architecture and `AGENTS.md`
- includes clear comments for non-obvious behavior
- is verified by tests, static checks, and direct file-content validation

## Workflow

### 1. Load context first
- Read the repository `AGENTS.md` and any directly relevant instruction files.
- Read the target files and adjacent tests before proposing changes.
- Identify whether the request affects shared orchestration, protocol-specific behavior, adapters, configuration, or tests.
- Confirm the most logical ownership boundary before editing files.

### 2. Decide whether TDD applies
Use TDD whenever the task changes behavior, fixes a bug, or adds logic that can be verified automatically.

#### If behavior changes
1. Add or update the smallest relevant test first.
2. Run the targeted test or otherwise confirm it fails for the expected reason.
3. Implement the smallest production change that makes the test pass.
4. Refactor only after behavior is protected.

#### If behavior does not change
- Prefer the lightest safe validation available.
- Document why a test-first approach was not necessary if the reason is non-obvious.

### 3. Place code in the right module
- Put shared orchestration in shared base classes or adapters.
- Keep VS Code protocol-specific behavior in the provider or command that owns it.
- Prefer extending an existing focused module over creating a parallel abstraction.
- Keep files small, hierarchical, and responsibility-driven.

### 4. Implement with KISS and DRY
- Prefer simple, explicit code over clever code.
- Extract shared helpers only when they remove meaningful duplication.
- Avoid copy-paste branches when a shared utility or adapter can express the behavior once.
- Keep side effects thin and isolate transformation logic where possible.

### 5. Document non-obvious behavior
Add comments where a future reader would otherwise need to reverse engineer intent.

Document:
- assumptions and invariants
- failure modes and guardrails
- request shaping or parsing rules
- streaming, trimming, retry, or routing behavior

Avoid comments that only restate the code.

### 6. Validate thoroughly
Before finishing:
1. Run the most relevant tests.
2. Run repository validation commands required by the task scope.
3. Re-read changed files to confirm the expected code exists.
4. If a new file was created, verify it exists on disk with the intended content.

Preferred validation sequence for non-trivial changes:
- `npm run compile`
- `npm run test:coverage`
- `npm run lint`
- `npm run format`

If the task is narrow, start with targeted tests and expand to the full validation set before completion.

## Decision points

### Shared vs protocol-specific change
- If the behavior should benefit multiple providers, prefer the shared base or adapter layer.
- If the behavior belongs only to chat, completions, or a specific command, keep it in that owner.

### Existing file vs new file
- Extend an existing module when ownership is already clear.
- Create a new file only when it gives a clearer responsibility boundary.

### Test scope
- Start with the closest unit test.
- Add integration coverage when multiple modules interact or when a regression spans boundaries.

## Completion checks
A task is complete only when all applicable items are true:
- Relevant tests were added or updated before implementation for behavior changes.
- The final code is modular, readable, and placed in the correct location.
- Non-obvious logic is documented with useful comments.
- The implementation follows KISS and avoids unnecessary duplication.
- Validation commands have been run as appropriate.
- Changed files were re-read, or new files were verified on disk.
- The repository state reflects the intended outcome.

## Example prompts
- Implement a new VS Code command in this extension using TDD first.
- Refactor provider request handling without breaking shared orchestration.
- Add tests and implement a fix for a streaming regression in the chat provider.
- Add a configuration-driven extension feature and validate compile, lint, and coverage.
