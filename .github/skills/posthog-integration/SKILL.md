---
name: posthog-integration
description: 'PostHog API / Integration for NodeJS/Typescript. Use when: implementing PostHog telemetry, adding analytics events, configuring PostHog adapters, writing telemetry tests, integrating feature flags, uploading sourcemaps, or debugging PostHog capture issues.'
argument-hint: 'What PostHog telemetry task do you need help with?'
---

# PostHog Integration — NodeJS/TypeScript

## When to Use

- Adding new telemetry events to `TelemetryService`
- Implementing or modifying `IPostHogAdapter` (Node or Web)
- Writing tests for PostHog adapters or telemetry service
- Integrating PostHog with lifecycle hooks (`PostHogHook`)
- Configuring feature flags via PostHog
- Uploading sourcemaps for error symbolication
- Debugging event capture, flush, or shutdown issues

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│              extension.ts (entry)                │
│  TelemetryService.initialize(context)            │
│  PostHogHook(telemetryService).initialize()      │
└──────────┬──────────────────────┬───────────────┘
           │                      │
┌──────────▼──────────┐  ┌───────▼────────────────┐
│  TelemetryService   │  │   Observability Layer  │
│  (typed capture     │  │  HookSystem            │
│   methods)          │  │  PostHogHook           │
└──────────┬──────────┘  └───────┬────────────────┘
           │                     │
┌──────────▼─────────────────────▼────────────────┐
│           IPostHogAdapter (interface)            │
├─────────────────────────────────────────────────┤
│ posthogAdapter.ts     │ posthogAdapter.web.ts   │
│ (posthog-node)        │ (posthog-js)            │
└──────────┬──────────────────────┬───────────────┘
           │                      │
┌──────────▼──────────────────────▼───────────────┐
│              PostHog Cloud                       │
│         us.i.posthog.com                         │
└─────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/telemetry/types.ts` | `IPostHogAdapter`, `PostHogConfig`, `TelemetryEvent`, `TelemetryPrimitive` |
| `src/telemetry/posthogAdapter.ts` | Node.js adapter wrapping `posthog-node` |
| `src/telemetry/posthogAdapter.web.ts` | Web adapter wrapping `posthog-js` |
| `src/telemetry/telemetryService.ts` | Central facade — typed capture methods, event enrichment |
| `src/observability/posthogHook.ts` | Bridge: HookSystem → TelemetryService |
| `scripts/upload-posthog-sourcemaps.mjs` | Sourcemap upload for error symbolication |

## Procedure: Adding a New Telemetry Event

### 1. Define the Event

Add a typed capture method to `TelemetryService`:

```typescript
// In src/telemetry/telemetryService.ts

captureMyNewEvent(properties: {
  caller: string;
  model?: string;
  durationMs?: number;
}): void {
  this.capture('my_new_event', {
    ...properties,
    // Enrichment is automatic: distinctId, extension_version, vscode_version, ui_kind, os
  });
}
```

### 2. Call from Production Code

Invoke from the appropriate location (provider, command, hook handler):

```typescript
import { TelemetryService } from '../telemetry/telemetryService';

// Inside your function:
telemetryService.captureMyNewEvent({
  caller: 'chat',
  model: 'gpt-4',
  durationMs: elapsed,
});
```

### 3. Write the Test First (TDD)

```typescript
// In src/telemetry/test/telemetryService.test.ts

it('should capture my_new_event with correct properties', () => {
  const adapter = sinon.createStubInstance(PostHogAdapter);
  const service = new TelemetryService(adapter as unknown as IPostHogAdapter);

  service.captureMyNewEvent({ caller: 'chat', model: 'gpt-4', durationMs: 150 });

  sinon.assert.calledOnce(adapter.capture);
  const [eventName, props] = adapter.capture.firstCall.args;
  expect(eventName).to.equal('my_new_event');
  expect(props).to.include({ caller: 'chat', model: 'gpt-4', durationMs: 150 });
  expect(props).to.have.property('distinctId');
  expect(props).to.have.property('extension_version');
});
```

### 4. Run Tests

```bash
npm run test:coverage
```

## Procedure: Implementing an Adapter

Adapters implement `IPostHogAdapter`:

```typescript
export interface IPostHogAdapter {
  initialize(config: PostHogConfig): void;
  capture(event: TelemetryEvent): void;
  captureException(error: Error, options?: TelemetryCaptureExceptionOptions): void;
  identify(distinctId: string, properties?: TelemetryPersonProperties): void;
  isFeatureEnabled(flag: string, distinctId: string): Promise<boolean>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  setEnabled(enabled: boolean): void;
}
```

**Node adapter** (`posthogAdapter.ts`): Uses `posthog-node` `PostHog` class.
**Web adapter** (`posthogAdapter.web.ts`): Uses `posthog-js` with `persistence: "memory"`.

Both guard all calls behind an `enabled` flag and return no-ops when disabled.

## Procedure: Integrating with HookSystem

Use `PostHogHook` to capture events from the request lifecycle:

```typescript
// In src/observability/posthogHook.ts
// Registers on hook points (e.g., 'after:transform')
// Captures: request_failed, trim_executed
```

To add a new hook-captured event:

1. Register handler on the appropriate `HookPoint` in `PostHogHook.initialize()`
2. Extract relevant data from `HookContext`
3. Call `telemetryService.captureXxx(...)` with extracted properties

## Configuration

**API Key & Host**: Hardcoded in `TelemetryService` (static readonly).

**Telemetry opt-in**: Respects `vscode.env.isTelemetryEnabled`. Adapter toggles via `setEnabled()` on `onDidChangeTelemetryEnabled`.

**User identification**: `vscode.env.sessionId` (preferred) or `vscode.env.machineId` as `distinctId`.

**Sourcemap upload** (env vars):
- `POSTHOG_HOST`
- `POSTHOG_PROJECT_API_KEY`
- `POSTHOG_PERSONAL_API_KEY`
- `POSTHOG_RELEASE`

```bash
npm run posthog:sourcemaps
```

## Testing Patterns

**Framework**: Mocha + Sinon + VS Code test runner

| What | How |
|------|-----|
| Adapter tests | Sinon sandbox, stub `PostHog.prototype.captureException` |
| Service tests | `sinon.createStubInstance(PostHogAdapter)`, verify event shape |
| Hook tests | `HookSystem.clear()` in setup, stub `StructuredLogger` |
| Disabled path | Verify no-ops when `enabled = false` |
| Pre-initialize | Verify no-ops before `initialize()` called |

**Coverage targets**: Statements/Branches/Functions 90%+, Lines 85%+

## Common Pitfalls

- **Forgetting enrichment**: Every event automatically gets `distinctId`, `extension_version`, `vscode_version`, `ui_kind`, `os` — don't duplicate these in `properties`.
- **Web adapter `isFeatureEnabled` is synchronous**: Node adapter returns `Promise<boolean>`, web adapter returns `boolean` directly. Handle both cases in consumers.
- **Missing `setEnabled` toggle**: Always test the disabled path; telemetry must be a no-op when `vscode.env.isTelemetryEnabled` is false.
- **Sourcemap upload requires production build**: Run `npm run build:posthog-sourcemaps` before uploading.
