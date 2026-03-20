---
name: generate-github-bug-report
description: "Use when generating a high-quality GitHub bug report following the repository's specific templates and standards."
---

# Generate GitHub Bug Report

Use this skill to create well-structured, detailed, and actionable bug reports that adhere to the repository's `.github/ISSUE_TEMPLATE/bug_report.yml` (or similar) requirements.

## Outcome
A complete, Markdown-formatted bug report (or YAML-aligned text) ready to be pasted into a GitHub issue, containing all necessary reproduction steps, environment details, and logs.

## Workflow

### 1. Gather Context
- Identify the core issue: What is broken? What was the user trying to do?
- Collect environment details:
    - AI/LLM Provider (OpenAI, Anthropic, etc.)
    - AI/LLM Model name (gpt-4o, claude-3-5-sonnet, etc.)
    - VS Code version and Extension version.
- Locate error logs: Check the "LiteLLM" output channel or VS Code Developer Tools (Console).

### 2. Formulate Reproduction Steps
- Create a clear, numbered list of steps.
- Start from a neutral state (e.g., "Open VS Code").
- Be specific about inputs or configurations used.

### 3. Define Expectations
- Contrast "What happened" (Actual) with "What should have happened" (Expected).

### 4. Apply Template Structure
Follow the structure defined in `.github/ISSUE_TEMPLATE/bug_report.yml`:
1. **Title**: Prefix with `[Bug]: ` followed by a concise summary.
2. **Description**: Clear summary of the bug.
3. **Steps to Reproduce**: Numbered list.
4. **Expected Behavior**: What you wanted to see.
5. **Environment & LLM Details**:
    - **Provider**: Specify the backend.
    - **Model**: Specific model string.
6. **Error Output/Log**: Wrap logs in ` ```shell ` blocks.
7. **Additional Context**: Screenshots, related issues, or specific workspace settings.

## Quality Criteria
- **Actionable**: A maintainer should be able to follow the steps and see the bug.
- **Complete**: No missing mandatory fields (Provider, Model, Logs).
- **Clean**: Proper Markdown formatting, no unnecessary "noise" or conversational filler.

## Example Prompt to Invoke
"I'm getting a 401 error when trying to use the completions provider with my local LiteLLM proxy. Can you generate a bug report for me?"
