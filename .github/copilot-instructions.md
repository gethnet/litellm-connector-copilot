# Copilot Instructions — LiteLLM Connector for Copilot

This repository uses `AGENTS.md` as the **single source of truth** for automated coding agent standards and project architecture.

If this file is present, keep it minimal and **avoid duplicating** guidance from `AGENTS.md`.

See `AGENTS.md`.

## Observability (PostHog)

The extension uses PostHog for telemetry. Key events and properties:
- `request.started`: modelId, caller, messageCount
- `request.validated`: modelFound, hasConfig
- `request.trimmed`: originalMessageCount, trimmedMessageCount
- `tokens.estimated`: tokenLimit, safetyLimit, toolTokenCount, budget
- `http.request.sent`: model, endpoint, retryCount
- `http.response.received`: status, durationMs
- `request.completed`: totalDurationMs, tokensIn, tokensOut, status
- `error.caught`: errorType, model, requestId

All events are sanitized to redact workspace paths. Machine-scoped UUID is stored in `globalState.telemetry.machineId`.
