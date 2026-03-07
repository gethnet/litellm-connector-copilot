---
name: vscode-extension-implementation
description: "Implement, fix, or refactor VS Code extension code in this repository using the vscode-extension-implementation skill."
argument-hint: What extension change should be made?
model: GPT-5
---
Use the `vscode-extension-implementation` skill.

Apply it to implement, fix, or refactor VS Code extension code in this repository.

## Required workflow
1. Read the repository instructions and the relevant source and test files.
2. If behavior changes, use TDD first: add or update the test before implementation.
3. Keep code modular, logically placed, simple, and well documented.
4. Validate with the appropriate tests and repository checks.
5. Re-read changed files or verify new files on disk before finishing.

## Task
{{$input}}
