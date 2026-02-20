# Telemetry & Logging Deep Dive

## Current Logging Infrastructure

### Logger Class (`src/utils/logger.ts`)
- **Purpose**: Centralized logging via VS Code's built-in LogOutputChannel
- **API**:
  - `static initialize(context: vscode.ExtensionContext)`: Create channel at activation
  - `static info(message, ...args)`: Info-level logs
  - `static warn(message, ...args)`: Warning-level logs
  - `static error(error|string, ...args)`: Error with stack trace support
  - `static debug(message, ...args)`: Debug-level logs
  - `static trace(message, ...args)`: Trace-level logs
  - `static show()`: Display log output channel to user
- **Initialization**: Called in `extension.ts` → `activate()` at very start
- **Channel Name**: "LiteLLM" (visible in VS Code output panel)
- **No external persistence**: Logs only stored in VS Code's session memory

### Current Logging Points in Request Flow
1. **Extension Activation** (`extension.ts`):
   - "Activating extension..."
   - User-Agent construction: "litellm-vscode-chat/{version} VSCode/{version}"
   - Provider registration status
   - Config migration status
   - Missing configuration prompts

2. **Model Discovery** (`LiteLLMProviderBase.discoverModels()`):
   - "discoverModels called"
   - Config URL status ("set" vs "not set")
   - "Fetching model info from LiteLLM..."
   - Invalid data format warnings
   - Model count, discovered provider names

3. **Request Processing** (`LiteLLMChatProvider.provideLanguageModelChatResponse()`):
   - modelIdOverride detection & retry attempts
   - Parameter filtering for unsupported ones
   - "Operation cancelled by user"
   - Retry-on-unsupported-params with details

4. **HTTP Layer** (`LiteLLMClient.chat()`):
   - Cache bypass logic (Anthropic exceptions)
   - Rate limiting & retry attempts
   - 400-error detection & parameter stripping
   - Endpoint routing details

5. **Token Management**:
   - Message trimming decisions
   - Token budget calculations (when verbose)

## Current Telemetry Infrastructure

### IMetrics Interface (`src/utils/telemetry.ts`)
```typescript
interface IMetrics {
  requestId: string;           // Random 7-char ID per request
  model: string;               // Model ID used
  durationMs?: number;         // Wall-clock time in ms
  tokensIn?: number;           // Input tokens (estimated, not actual)
  tokensOut?: number;          // Output tokens (estimated, not actual)
  status: "success" | "failure" | "caching_bypassed";
  error?: string;              // Error message if failed
  caller?: string;             // Context tag: "inline-completions", "terminal-chat", etc.
}
```

### Telemetry Emission Points
1. **Chat Response Completion** (`LiteLLMChatProvider.provideLanguageModelChatResponse()`):
   - On success: duration, token counts, success status
   - On error: error message, failure status
   - **Caller extracted**: `(model as any).tags?.[0]`

2. **Caching Bypass Events** (`LiteLLMClient.chat()`):
   - When disableCaching=true but Anthropic model detected
   - Status: "caching_bypassed"
   - No duration/token data

3. **Completions Requests** (`LiteLLMCompletionProvider`):
   - Same metric structure as chat
   - Caller may be "inline-completions" if invoked from inline API

### Current Reporting Behavior
- `LiteLLMTelemetry.reportMetric(metric)`:
  - Serializes metric to JSON
  - Logs to `Logger.debug()` with `[Telemetry]` prefix
  - **That's it** - no external backend, no sampling, no batching
  - Designed as a hook for future integration

### Timer Utilities
- `LiteLLMTelemetry.startTimer()`: Returns `Date.now()`
- `LiteLLMTelemetry.endTimer(start)`: Returns `Date.now() - start`

## Test Coverage

### Logger Tests (`src/test/unit/logger.test.ts`)
- ✅ Channel creation and subscription management
- ✅ All methods (info, warn, error, debug, trace)
- ✅ Error object vs string handling
- ✅ show() functionality

### Telemetry Tests (`src/test/unit/telemetry.test.ts`)
- ✅ reportMetric() calls Logger.debug()
- ✅ Timer methods return numbers
- ✅ Caller context is included in serialization
- ✅ Multiple caller contexts tested
- ✅ Handles missing optional fields

## Gaps & Design Readiness

### Gaps
1. **No external telemetry backend**
   - No PostHog, Datadog, Segment, custom endpoint, etc.
   - Current logs are ephemeral (lost on session end)

2. **No structured event schema**
   - IMetrics interface is minimal
   - No event categorization (page views, funnel steps, errors)
   - No custom properties/dimensions

3. **No sampling or rate-limiting**
   - Every request emitted as telemetry
   - High-volume events could overwhelm backend

4. **No batch collection**
   - Single-metric-at-a-time design
   - No local queue, no background flush

5. **Token counts not actual**
   - `tokensIn`/`tokensOut` estimated or undefined
   - LiteLLM doesn't expose token usage in responses (API limitation)
   - Can't measure actual consumption

6. **Incomplete caller attribution**
   - Only captures primary context (model tag)
   - Nested calls (e.g., tool-retry) lose context

### Design Readiness for Integration
✅ **Excellent foundations**:
- Centralized telemetry interface (easy to swap implementation)
- Hooks at all major decision points
- Request IDs for tracing
- Caller context already captured
- Error information captured
- Timing data collected
- IMetrics interface extensible (new fields easy to add)

✅ **Easy to implement**:
- PostHog: Drop-in library, call PostHog SDK in `reportMetric()`
- Custom HTTP: POST metrics to backend endpoint
- Conditional: Send only on sampling threshold
- Batch: Collect metrics locally, flush periodically

## Key Observations

1. **Logging is pure operational**: Helps developers/users understand extension behavior
2. **Telemetry is ready for monetization**: Can measure adoption, usage patterns, errors
3. **No privacy concerns yet**: No user data, only model IDs and timing
4. **Architecture is extensible**: Can add external backend without breaking existing code
5. **Caller context is valuable**: Can segment usage by chat vs inline vs commands
6. **Token estimates are rough**: For informational purposes only, not billing
