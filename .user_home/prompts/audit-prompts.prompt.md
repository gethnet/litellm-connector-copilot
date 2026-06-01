---
description: 'Audit .prompt.md and .agent.md files for effectiveness: detect name conflicts, validate references, find scope contradictions. Outputs report to disk with fixes suggested.'
name: 'Audit Prompts'
argument-hint: 'Target folder or repo path to audit (default: current workspace)'
inputs:
  target:
    description: 'Path to scan for prompt/agent files (.prompt.md, .agent.md)'
    default: '.'
  fix:
    description: 'Whether to auto-fix issues or just report'
    default: 'false'
---

# Audit Prompts for Effectiveness

Analyze `.prompt.md` and `.agent.md` files for quality issues that reduce effectiveness.

## Target
Scan: `${input:target}`

## Audit Checks

### 1. Name Uniqueness
- Detect duplicate `name:` frontmatter values
- Find similar names that could cause confusion

### 2. Reference Validation
- Verify `agent:` references exist (e.g., `agent: "Co-Coder-TS_VSC"`)
- Verify `skill:` references exist in the same repo or user skills
- Verify file paths in instructions exist

### 3. Scope Conflict Detection
- Find contradicting guidance between prompts
- Detect overlapping `applyTo` patterns
- Check for missing `applyTo` on prompts that need file scoping

### 4. Frontmatter Quality
- Verify required fields: `name`, `description`
- Check `description` follows "Use when..." pattern
- Validate YAML syntax (quoted strings for colons)

### 5. Template Completeness
- Verify prompt body has actionable steps
- Check for placeholder `${input:...}` variables defined in frontmatter

## Output

For each issue found, report:
- File path and line number
- Issue type (name_conflict, broken_reference, scope_conflict, etc.)
- Why it's a problem
- Suggested fix

## Report Location

Write findings to: `.user_home/prompt-audit-results.md`

If file save fails, output full report to chat as markdown.

## Auto-Fix Mode

If `${input:fix}` is `true`, attempt to:
- Add missing frontmatter fields
- Quote unquoted descriptions with colons
- Suggest renamed names for conflicts