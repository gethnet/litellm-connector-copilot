# Implementation Plan Metadata Schema

The canonical metadata contract for implementation plans is [`plan-metadata.schema.json`](./plan-metadata.schema.json). Plan files remain executable `*.prompt.md` documents; this schema governs the archival and search metadata placed in their YAML frontmatter.

## Design goals

- Preserve `*.prompt.md` so an agent treats the document as an executable instruction contract.
- Give every plan a stable identity independent of its filename or lifecycle directory.
- Support searches by lifecycle, architecture, topic, issue, pull request, commit, and release.
- Keep active-plan metadata concise while allowing traceability fields to be populated at completion.
- Permit future incompatible changes through `schema_version`.

## Canonical header

Use this header when creating a plan. Remove optional sections that have no values; do not store empty strings or placeholder values.

```yaml
---
schema_version: 1
id: restore-reasoning-gates
title: Restore reasoning gates and expand explicit fields
plan_kind: bug_fix
status: pending
description: Restore conservative reasoning-effort gates while supporting additional explicit LiteLLM fields.
created_at: "2026-07-10"
updated_at: "2026-07-10"
author: gethnet
requester: gethnet
areas:
  - model-capabilities
  - providers
tags:
  - reasoning-effort
  - litellm
  - regression
affected_files:
  - src/utils/modelCapabilities.ts
  - src/utils/test/modelCapabilities.test.ts
github:
  issues:
    - 123
relationships:
  depends_on: []
  supersedes: []
  related: []
---
```

When implementation is complete, update the lifecycle and traceability fields:

```yaml
status: completed
outcome: implemented
completed_at: "2026-07-16"
github:
  issues:
    - 123
  pull_requests:
    - 124
implementation:
  commits:
    - abc123def456
  release_version: "2.2.0"
validation:
  compile: passed
  lint: passed
  format: passed
  test_coverage: passed
```

## Required fields

| Field | Meaning |
|---|---|
| `schema_version` | Metadata contract version. Version 1 is represented by integer `1`. |
| `id` | Stable kebab-case identifier. Never change it merely because the file moves or is renamed. |
| `title` | Human-readable title suitable for indexes and search results. |
| `plan_kind` | Primary work category. Use one value rather than combining categories. |
| `status` | Current lifecycle state. |
| `description` | One sentence describing the intended outcome. The name intentionally aligns with VS Code prompt-file metadata. |
| `created_at` | ISO 8601 calendar date on which the plan was first drafted. |
| `areas` | Stable architectural ownership terms used for faceted searches. |
| `tags` | Flexible technical, product, and incident terms used for topical searches. |

A completed plan must additionally provide `completed_at` and `outcome`. A superseded plan must identify `relationships.superseded_by`.

## Controlled vocabulary

### `plan_kind`

- `feature`
- `bug_fix`
- `refactor`
- `migration`
- `maintenance`
- `investigation`
- `security`
- `performance`
- `documentation`
- `testing`

### `status`

- `proposed` — an idea not yet accepted for implementation
- `pending` — accepted and ready to implement
- `in_progress` — currently being implemented
- `blocked` — implementation cannot proceed
- `completed` — execution finished successfully or with a recorded final outcome
- `abandoned` — deliberately closed without implementation
- `superseded` — replaced by another plan

### `outcome`

- `implemented`
- `partially_implemented`
- `not_implemented`
- `replaced`

`status` records lifecycle; `outcome` records disposition. Archival is represented separately by `archived_at`, so moving a completed plan into `.plans/archived` does not erase the fact that it was completed. For example, an investigation can be `completed` with an outcome of `not_implemented` when it concludes that no code change is appropriate.

## Field guidance

### Areas versus tags

Keep `areas` stable and architectural, for example:

- `providers`
- `adapters`
- `configuration`
- `telemetry`
- `model-discovery`
- `model-capabilities`
- `streaming`
- `token-accounting`

Use `tags` for less stable or cross-cutting terms such as model names, protocols, symptoms, and feature vocabulary.

### GitHub references

Use repository-local positive integers under `github`. Arrays support plans associated with multiple issues or pull requests without changing the field shape.

### Implementation references

Populate `implementation` only when values exist. `commits` accepts abbreviated or full Git hashes. `release_version` records the first released extension version containing the implementation.

### Relationships

Relationships reference stable plan `id` values, not filenames. This keeps links valid when plans move among `.plans/proposed`, `.plans/pending`, `.plans/completed`, and `.plans/archived`.

### Dates

Use quoted `YYYY-MM-DD` values. Quoting prevents YAML parsers from implicitly converting dates into language-specific date objects.

## Evolution rules

1. Backward-compatible additions may be made without changing `schema_version`:
   - adding optional properties
   - adding documentation or examples
   - relaxing a constraint
2. Increment `schema_version` for incompatible changes:
   - removing or renaming properties
   - making an optional property required
   - changing the meaning or type of a property
   - removing an accepted enum value
3. Keep older schemas available when introducing a new version so archived plans remain interpretable.
4. Update plan-generation instructions and templates whenever the required header changes.

## Validation

The JSON Schema validates the YAML frontmatter object rather than the complete Markdown file. A future validation script can extract the text between the first pair of `---` delimiters, parse it as YAML, and validate it against `plan-metadata.schema.json`.

Until automated validation is added, treat the JSON Schema as the source of truth and this document as usage guidance.
