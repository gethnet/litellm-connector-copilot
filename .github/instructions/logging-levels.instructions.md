---
description: "Use when writing or modifying TypeScript code under src/ that adds or edits StructuredLogger calls. Codifies the per-level decision table so any agent picks the right verbosity and keeps noise out of failure triage."
applyTo: "src/**/*.ts"
---

# StructuredLogger Level Decision Table

This file is the **single source of truth** for which
`StructuredLogger` level to use in any given situation. Whenever you
add, edit, or refactor a log call under `src/`, follow this table
exactly. Do not invent new levels. Do not "round up" to a louder
level — when in doubt, choose the **quieter** level that still tells
the operator what they need.

The goal: at the default `info` verbosity, an operator triaging a
real failure sees only meaningful lifecycle and failure signal.
Detail floods (`debug`, `trace`) can be toggled on via the output
channel dropdown in VS Code when needed.

## The table

| Level   | Use for                                                                                       | Visible at default `info`? |
| ------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| `error` | Hard failures, thrown exceptions, quota exhaustion, request failures.                          | **Yes**                     |
| `warn`  | Recoverable issues, parameter suppression, unexpected but tolerated shapes, sanitized inputs. | **Yes**                     |
| `info`  | High-level lifecycle events: function entry/exit at coarse granularity, completion status.    | **Yes**                     |
| `debug` | Detailed flow information, branch decisions, intermediate values, endpoint selection.          | No (suppress at default)    |
| `trace` | Full payloads, raw data, per-iteration counters, exhaustive part-by-part traces.              | No (suppress at default)    |

## Decision algorithm

Apply the rules **in order**; the first match wins. This is the same
algorithm the `/add-logging-only` and `/test-and-log` prompts use.

1. **Failure that breaks the request** → `error`.
   Always include the error object/cause and a stable correlation key
   (`requestId`, `model`, `endpoint`) in the options bag.
2. **Fallback, suppression, or degradation the system handled
   gracefully** → `warn`.
   Examples: a parameter was stripped, an endpoint was downgraded, a
   tool name was truncated, a shape was coerced.
3. **Lifecycle milestone** (function entered, function completed,
   count returned, request started/finished) → `info`.
   One log per major function at the top of its body, and one at
   the bottom. Do not log every step at `info`.
4. **Branch decision the operator would only want when debugging** →
   `debug`.
   Examples: which `if` arm was taken, which endpoint was selected,
   whether a parameter passed the filter.
5. **Per-element trace** (every loop iteration, every part counted,
   every byte encoded, raw SSE frames) → `trace`.
   If a `for`/`while`/`reduce` would log N times for N items, use
   `trace` for the per-item event and `info`/`debug` for the summary.

## Call shape

Always use the project convention:

```typescript
StructuredLogger.<level>("<area>.<verb>", { ...data }, { requestId?, model?, endpoint?, caller? });
```

- **Event name** — dotted, present-tense, namespaced by area
  (`tokenizer.part_counted`, `stream.tool_call_buffered`,
  `v2.convert.completed`). Reuse the existing `EventType` enum in
  `src/observability/types.ts` when one fits; otherwise introduce a
  new namespaced string.
- **Data** — the **inputs that drove the decision**, e.g.
  `{ hasValue: typeof part === "object" && "value" in part, kind: "string" }`.
  Never log secrets, raw request bodies, or PII.
- **Options** — add `requestId`/`model`/`endpoint`/`caller` if a
  correlation context is available. The logger fills in
  `"no-request"` when omitted, so prefer to omit over fabricating a
  fake id.

## Sanitization rules

- Never log API keys, tokens, secrets, raw request bodies, or
  user-identifying data.
- Truncate or hash large payloads; log only `{ length, hash, keys }`
  if needed.
- Reuse the project's existing sanitization helpers if present (e.g.
  the `sanitize*` helpers in `src/utils/`).
- `Uint8Array` payloads must be summarized as `{ byteLength }`, not
  converted to a string.

## What to avoid

- **Don't log every iteration at `info`.** A `for` over message parts
  belongs at `trace`; the summary (total tokens, total parts) goes
  at `info` or `debug`.
- **Don't write `logger.info('Done')` with no data.** Always include
  the fields that justify the call: counts, ids, durations, kinds.
- **Don't downgrade a real failure to `warn`** to keep the output
  channel quiet. The `error` level is the only level guaranteed to
  surface in failure triage.
- **Don't upgrade a routine branch decision to `info`** to make it
  visible. If it would be noisy, it belongs at `debug`.
- **Don't use `console.log` / `console.error` / `console.warn`**
  in production code. Use `StructuredLogger` so output is funneled
  into the dedicated `LiteLLM Structured` channel and respects the
  verbosity dropdown.

## Reference examples

### `error` — hard failure with correlation

```typescript
StructuredLogger.error("request.failed", {
    error: (error as Error).message,
    stack: (error as Error).stack,
}, { requestId, model, endpoint, caller });
```

### `warn` — graceful degradation

```typescript
StructuredLogger.warn("stream.tool_name_truncated", {
    name: originalName,
    source: "streamer",
    originalLength: originalName.length,
    sanitizedLength: 0,
});
```

### `info` — lifecycle milestone

```typescript
StructuredLogger.info("v2.convert.completed", {
    messageCount: messages.length,
    totalParts,
});
```

### `debug` — branch decision

```typescript
StructuredLogger.debug("endpoint.selected", {
    model,
    endpoint,
    reason: "model_supports_responses",
});
```

### `trace` — per-iteration detail

```typescript
StructuredLogger.trace("tokenizer.part_counted", {
    kind: "string",
    tokens: n,
});
```

## Verification checklist (when adding or editing log calls)

- [ ] The level chosen matches the decision algorithm above.
- [ ] The event name is dotted, namespaced, and consistent with
      neighbors in the same file.
- [ ] The data payload contains the inputs that drove the decision
      (not just a static string).
- [ ] No secrets, raw request bodies, or PII are present in the
      payload.
- [ ] `requestId`/`model`/`endpoint`/`caller` are passed when a
      correlation context is available; otherwise the options bag is
      omitted.
- [ ] JSDoc on the touched function documents the new log events
      and their levels.
- [ ] The full test suite still passes (`npm run test`) and
      coverage does not regress (`npm run test:coverage`).
- [ ] `npm run lint` and `npm run format` are clean.

## Related customizations

- `/test-and-log` — adds tests **and** logging in one workflow.
- `/add-logging-only` — adds logging only (use this when coverage
  already exists).
- `/add-tests-only` — adds tests only (use this when observability
  is already sufficient).
- `AGENTS.md` — repo-wide engineering standards.
