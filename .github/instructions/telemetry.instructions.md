---
description: "Use when writing or modifying telemetry code under src/telemetry/ to enforce PostHog integration standards, event naming conventions, and testing requirements."
applyTo: "src/telemetry/**"
---

# Telemetry Standards

## Enrichment Rules

Every event captured via `TelemetryService.capture()` is **automatically enriched** with these properties:

| Property | Source |
|----------|--------|
| `distinctId` | `vscode.env.sessionId` or `vscode.env.machineId` |
| `extension_version` | Package.json version |
| `vscode_version` | `vscode.version` |
| `ui_kind` | `vscode.UIKind[vscode.env.uiKind]` |
| `os` | `process.platform` or `"web"` |

**Never duplicate these properties** in your event's `properties` argument. The private `capture()` method merges them automatically.

## Event Naming Convention

- Use **`snake_case`** for all event names
- Use **past-tense verbs** for completed actions: `request_completed`, `feature_toggled`, `trim_executed`
- Use **noun + past participle** for state changes: `backend_added`, `model_not_found`, `quota_error`
- Property keys also use `snake_case`: `duration_ms`, `token_count`, `error_type`

## Adding a New Event

### 1. Add a typed capture method to `TelemetryService`

```typescript
// In src/telemetry/telemetryService.ts

captureMyNewEvent(props: {
  caller: string;
  model?: string;
  durationMs?: number;
}): void {
  this.capture("my_new_event", props);
}
```

- Method name: `capture` + PascalCase descriptor
- Parameter: single `props` object with typed fields (not positional args)
- Event name: `snake_case` string matching the method intent

### 2. Call from production code

```typescript
telemetryService.captureMyNewEvent({
  caller: "chat",
  model: "gpt-4",
  durationMs: elapsed,
});
```

### 3. Write the test first (TDD)

```typescript
test("should capture my_new_event with correct properties", () => {
  telemetryService.initialize(mockContext);
  telemetryService.captureMyNewEvent({ caller: "chat", model: "gpt-4", durationMs: 150 });

  assert.strictEqual(adapterMock.capture.calledOnce, true);
  const event = adapterMock.capture.firstCall.args[0];
  assert.strictEqual(event.event, "my_new_event");
  assert.strictEqual(event.properties.caller, "chat");
  assert.strictEqual(event.properties.model, "gpt-4");
  // Enrichment is automatic — verify it's present
  assert.strictEqual(event.properties.distinctId, "test-crash-reporter-id");
  assert.strictEqual(event.properties.extension_version, "1.0.0");
});
```

## Adapter Contract

`IPostHogAdapter` (defined in `src/telemetry/types.ts`) is the **only interface** adapters implement:

```typescript
export interface IPostHogAdapter {
  initialize(config: PostHogConfig): void;
  capture(event: TelemetryEvent): void;
  captureException(error: Error, options?: TelemetryCaptureExceptionOptions): void;
  identify(distinctId: string, properties?: TelemetryPersonProperties): void;
  isFeatureEnabled(flagKey: string, distinctId?: string): Promise<boolean> | boolean;
  reloadFeatureFlags(): Promise<void> | void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  setEnabled(enabled: boolean): void;
}
```

- **Node adapter** (`posthogAdapter.ts`): wraps `posthog-node` `PostHog` class
- **Web adapter** (`posthogAdapter.web.ts`): wraps `posthog-js` with `persistence: "memory"`

Both must guard all calls behind the `enabled` flag and return no-ops when disabled or uninitialized.

## Disabled-Path Testing (Required)

**Every new capture method must test the disabled path.** This is non-negotiable.

```typescript
test("should not capture when telemetry is disabled", () => {
  adapterMock.setEnabled(false);
  telemetryService.captureMyNewEvent({ caller: "chat" });

  assert.strictEqual(adapterMock.capture.called, false);
});
```

Also test the **pre-initialize path** for adapter methods:

```typescript
test("should no-op before initialize is called", () => {
  const adapter = new PostHogAdapter();
  adapter.capture({ event: "test", properties: {} }); // Should not throw
});
```

## Telemetry Opt-In

- `TelemetryService.initialize()` sets `enabled` based on `vscode.env.isTelemetryEnabled`
- Listens to `vscode.env.onDidChangeTelemetryEnabled` to toggle at runtime via `adapter.setEnabled()`
- **Never bypass this check.** All capture paths flow through the adapter's `enabled` guard.

## Security

- **Never include secrets** (API keys, tokens, passwords) in event properties
- **Never include PII** (usernames, emails, file paths with user home directories) unless explicitly required and documented
- `distinctId` uses `vscode.env.sessionId` (preferred) or `machineId` — these are opaque identifiers, not PII

## Property Types

Event properties must use `TelemetryPrimitive` types only:

```typescript
export type TelemetryPrimitive = string | number | boolean | null;
export type TelemetryEventProperties = Record<string, TelemetryPrimitive | TelemetryPrimitive[] | undefined>;
```

- No nested objects in properties
- No functions, symbols, or `undefined`-only values
- Arrays must contain only primitives

## Exception Capture

Use `captureException()` for errors, not `capture()` with error properties:

```typescript
telemetryService.captureException(error, {
  caller: "chat",
  level: "error",
  properties: { model: "gpt-4", endpoint: "/chat/completions" },
});
```

The adapter enriches exceptions with the same properties as regular events.

## Feature Flags

- `isFeatureEnabled(flagKey, distinctId?)` — returns `Promise<boolean>` (Node) or `boolean` (Web)
- `reloadFeatureFlags()` — force-refresh flags from PostHog cloud
- Always handle both sync and async return types when consuming feature flags

## Coverage Requirements

| Metric | Minimum |
|--------|---------|
| Statements | 90% |
| Branches | 90% |
| Functions | 90% |
| Lines | 85% |

No category may drop by more than 1% from current baseline.

## Sourcemap Upload

For error symbolication in PostHog:

```bash
npm run posthog:sourcemaps
```

Requires env vars: `POSTHOG_HOST`, `POSTHOG_PROJECT_API_KEY`, `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_RELEASE`.

Always run `npm run build:posthog-sourcemaps` before uploading.
