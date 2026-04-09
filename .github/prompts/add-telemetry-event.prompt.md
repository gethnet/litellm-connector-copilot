---
name: add-telemetry-event
description: 'Add a new PostHog telemetry event with typed capture method, call site, and unit test. Use when: adding analytics tracking for a new user action, error condition, or performance metric.'
argument-hint: 'Event name, properties, and call site (e.g. "backend_switched: caller, fromBackend, toBackend — call from modelPicker.ts")'
agent: agent
---

Add a new PostHog telemetry event to the extension.

## Inputs

Parse the user's request to extract:
1. **Event name** — snake_case (e.g. `backend_switched`)
2. **Properties** — typed fields with names and types (e.g. `caller: string, fromBackend: string, toBackend: string`)
3. **Call site** — file and function where the event should be captured

## Steps

### 1. Add Typed Capture Method to `TelemetryService`

In `src/telemetry/telemetryService.ts`, add a new public method following the existing pattern:

```typescript
capture<EventNameInPascalCase>(props: { <typed properties> }): void {
    this.capture("<event_name>", props);
}
```

- Method name: `capture` + PascalCase event name (e.g. `captureBackendSwitched`)
- Parameter: single object with typed properties
- Body: delegate to `this.capture()` with the snake_case event name and the props object
- Do NOT manually add `distinctId`, `extension_version`, `vscode_version`, `ui_kind`, or `os` — the private `capture()` method enriches every event automatically

Place the method in the most appropriate section (Lifecycle, Configuration, Feature usage, Performance & pain points, Model discovery, or Feature usage reporting). Create a new section comment if none fit.

### 2. Add Call Site Invocation

In the specified file and function, import `TelemetryService` and call the new method:

```typescript
import { TelemetryService } from '../telemetry/telemetryService';

// Inside the function, at the point where the event occurs:
telemetryService.capture<EventNameInPascalCase>({
    caller: '<context>',
    <other properties with actual values>,
});
```

If no call site is specified, add a TODO comment with the method signature and ask the user where to wire it.

### 3. Write Unit Test

In `src/telemetry/test/telemetryService.test.ts`, add a test following the existing pattern:

```typescript
test("should capture <event_name> with correct properties", () => {
    const mockContext = {
        extension: { packageJSON: { version: "1.0.0" } },
    } as unknown as vscode.ExtensionContext;

    telemetryService.initialize(mockContext);
    telemetryService.capture<EventNameInPascalCase>({
        <provide sample values for each property>,
    });

    assert.strictEqual(adapterMock.capture.calledOnce, true);
    const event = adapterMock.capture.firstCall.args[0];
    assert.strictEqual(event.event, "<event_name>");
    assert.strictEqual(event.properties.<prop>, <value>);
    // Verify enrichment is present
    assert.strictEqual(event.properties.distinctId, "test-crash-reporter-id");
    assert.strictEqual(event.properties.extension_version, "1.0.0");
});
```

### 4. Validate

Run `npm run compile` and `npm run test:coverage` to verify:
- No type errors
- New test passes
- Coverage does not regress below 85% lines / 90% statements

## Quality Checklist

- [ ] Event name is snake_case
- [ ] Method name is `capture` + PascalCase
- [ ] Properties are typed (no `any`)
- [ ] Enrichment properties are NOT duplicated in the capture call
- [ ] Test verifies event name, all properties, and enrichment fields
- [ ] `npm run compile` passes
- [ ] `npm run test:coverage` passes with no regression
