# Skill: Plan Creation and Refinement

Use this skill when tasked with creating, reviewing, or refining implementation plans for complex coding tasks. This skill ensures plans are actionable, balanced (specific but flexible), and aligned with repository standards.

## 1) Core Principles

- **Actionable Accuracy**: Plans must break down a high-level request into concrete, sequential steps.
- **Balanced Constraint**: Provide enough detail (file paths, specific logic points) to guide the LLM, but avoid over-specifying every line of code to prevent the LLM from getting "stuck" or ignoring better implementation choices.
- **TDD Integration**: Every behavior-changing plan MUST include a step for creating or updating tests.
- **Context-Aware**: Reference existing architecture (e.g., `LiteLLMProviderBase`) and standards (e.g., `AGENTS.md`).

## 2) Workflow

### Phase 1: Research & Discovery
- Identify the core logic and its side effects.
- Locate all affected files (orchestrators, adapters, types, tests).
- Check for existing patterns or helpers that should be reused.

### Phase 2: Drafting the Plan
Structure the plan into clear sections:
1. **Goal**: A 1-sentence description of the desired end state.
2. **Steps**: A numbered list of atomic actions.
   - Include specific file paths.
   - Mention key variables or configuration keys.
   - Explicitly include test updates.
3. **Verification**: How to prove the change works (e.g., "Run `npm run test` and verify X").

### Phase 3: Refinement
Review the drafted plan against these criteria:
- **Is it too vague?** (e.g., "Fix the bug in the provider") -> *Add file paths and logic details.*
- **Is it too strict?** (e.g., "Write exactly `if (x === 1) return y` on line 42") -> *Generalize to "Handle the edge case where x is 1".*
- **Is it modular?** (e.g., Does it respect the 1000-line limit?) -> *Add a step to split files if necessary.*

## 3) Quality Checklist

- [ ] Plan includes specific file paths.
- [ ] Plan includes TDD/test update steps.
- [ ] Plan respects repo-wide constraints (e.g., `AGENTS.md`).
- [ ] Plan provides "Why" for non-obvious changes.
- [ ] Plan is stored in `.plans/` directory for visibility.

## 4) Example Prompts

- "Research the request and create a plan in `.plans/` for implementing tool-call buffering."
- "Review my current plan for splitting `LiteLLMProviderBase` and refine it to be more modular."
- "Refine this plan to ensure it follows a TDD-first approach."
