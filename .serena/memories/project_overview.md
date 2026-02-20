# LiteLLM Connector for GitHub Copilot - Project Overview

## Project Purpose
A VS Code extension that integrates the LiteLLM proxy into GitHub Copilot Chat, allowing users to use hundreds of language models (OpenAI, Anthropic, Google, Mistral, etc.) directly from the Copilot UI. Supports chat, tool calling, vision, and optional inline completions.

## Tech Stack
- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **Key Dependencies**:
  - `vscode` (v1.109+ required for Language Model provider API)
  - `@vscode/dts` for proposed APIs
  - Development: `sinon`, `mocha`, `eslint`, `prettier`, esbuild for bundling
- **Key Features**: Streaming, SSE parsing, token management, tool calls, model caching

## Architecture Pattern (Provider Base + Derived)
- **Base Orchestrator**: `LiteLLMProviderBase`
  - Centralized model discovery & caching
  - Shared message ingress pipeline (normalize, validate, filter, trim)
  - Endpoint routing & HTTP transport
  - Error handling & quota detection
  - Shared telemetry infrastructure
  
- **Chat Provider**: `LiteLLMChatProvider` (implements `vscode.LanguageModelChatProvider`)
  - Streaming-specific logic (tool call buffering, response parts)
  - Delegates orchestration to base
  
- **Completions Provider**: `LiteLLMCompletionProvider` (implements stable inline API)
  - Prompt-to-message wrapping for base pipeline
  - Completion text extraction
  
- **Inline Provider**: `LiteLLMInlineCompletionProvider`
  - VS Code inline completions API
  - Optional, disabled by default

## Code Structure
```
src/
├── extension.ts                    # Entry point, provider registration
├── types.ts                        # Shared type definitions
├── utils.ts                        # Utility functions
├── providers/
│   ├── liteLLMProviderBase.ts     # Shared orchestration
│   ├── liteLLMChatProvider.ts     # Chat protocol implementation
│   └── liteLLMCompletionProvider.ts # Completions protocol
├── adapters/
│   ├── litellmClient.ts           # HTTP client with retry/rate-limit
│   ├── tokenUtils.ts              # Token counting/trimming
│   ├── responsesClient.ts         # /responses endpoint support
│   └── responsesAdapter.ts        # Format transformation
├── config/
│   └── configManager.ts           # Configuration & secrets management
├── commands/
│   ├── manageConfig.ts            # Configuration UI commands
│   └── inlineCompletions.ts       # Inline completions commands
├── inlineCompletions/
│   ├── liteLLMInlineCompletionProvider.ts
│   └── registerInlineCompletions.ts
└── utils/
    ├── logger.ts                   # VS Code LogOutputChannel wrapper
    ├── telemetry.ts                # Telemetry/metrics (DEBUG-only currently)
    └── modelUtils.ts               # Model capability helpers
```

## Logging & Telemetry Setup

### Current Implementation
- **Logger** (`src/utils/logger.ts`):
  - Wraps VS Code's `LogOutputChannel` API
  - Methods: `info()`, `warn()`, `error()`, `debug()`, `trace()`, `show()`
  - Initialization in `extension.ts`
  - No external telemetry backend (local only)

- **Telemetry** (`src/utils/telemetry.ts`):
  - Interface `IMetrics` with fields: `requestId`, `model`, `durationMs`, `tokensIn`, `tokensOut`, `status`, `error`, `caller`
  - `reportMetric()` currently logs to `Logger.debug()` (architectured for future integration)
  - Timer utilities: `startTimer()`, `endTimer()`
  - **No PostHog or external integration yet** (ready for implementation)

### Telemetry Emission Points
- `LiteLLMChatProvider.provideLanguageModelChatResponse()`: Calls `reportMetric()` on completion
- `LiteLLMClient.chat()`: Logs caching bypass events
- Various modules log via `Logger` for operational visibility

### Gaps
- No external telemetry backend (PostHog, etc.) integrated
- No structured event schemas (ready for implementation)
- No sampling/filtering logic for high-volume events
- No batch collection mechanism

## Request Flow Architecture

### Entry Points
1. **Chat**: VS Code → `vscode.lm.registerLanguageModelChatProvider()` → `LiteLLMChatProvider.provideLanguageModelChatResponse()`
2. **Completions** (inline): VS Code → `vscode.languages.registerInlineCompletionItemProvider()` → `LiteLLMInlineCompletionProvider.provideInlineCompletionItems()`
3. **Commands**: User triggers via command palette (manage config, reload models, etc.)

### Request Handling Flow

1. **Entry**: Chat/Completions provider receives request
   - `model`: Selected LiteLLM model
   - `messages` or `prompt`: Request content
   - `options`: Model options, tools, configuration
   - `progress`: Callback to emit response parts

2. **Base Orchestration** (`LiteLLMProviderBase.buildOpenAIChatRequest()`):
   - Convert to OpenAI-compatible format
   - Validate request (check model exists)
   - Filter unsupported parameters via `KNOWN_PARAMETER_LIMITATIONS`
   - Trim messages to fit token budget (`trimMessagesToFitBudget()`)
   - Detect quota errors from chat history

3. **HTTP Layer** (`LiteLLMClient.chat()`):
   - Decide endpoint: `/chat/completions`, `/completions`, or `/responses`
   - Apply no-cache headers if configured
   - Add rate-limiting & retry logic
   - Handle 400 errors by retrying with stripped parameters

4. **Response Handling**:
   - **Chat/Completions**: Stream SSE → parse chunks → emit `LanguageModelResponsePart`
   - **Responses endpoint**: Special SSE format handling via `ResponsesClient`
   - Tool call buffering for partial streaming

5. **Completion**:
   - Track metrics (duration, token counts, status)
   - Report via `LiteLLMTelemetry.reportMetric()`

### Key Handler Locations
- `LiteLLMProviderBase.sendRequestToLiteLLM()`: Routes to endpoint and streams
- `LiteLLMChatProvider.processStreamingResponse()`: Parses SSE, handles tool calls
- `ResponsesClient.parseSSEStream()`: Handles `/responses` endpoint format
- `LiteLLMInlineCompletionProvider.provideInlineCompletionItems()`: Completions entry point

## Token Management

### Location: `src/adapters/tokenUtils.ts`

**Functions**:
- `estimateMessagesTokens()`: Sum tokens across all messages (rough estimate: length / 4)
- `estimateSingleMessageTokens()`: Token count for one message
- `estimateToolTokens()`: Token cost of tool definitions (JSON size / 4)
- `trimMessagesToFitBudget()`: Keep system message + as much recent context as possible
  - Anthropic models get 2% safety margin
  - Handles continuation requests specially
  - Preserves protected assistant messages for context

**Token Budget Flow**:
1. Model specifies `maxInputTokens` (from `/model/info`)
2. Tool token cost subtracted from budget
3. Messages trimmed from oldest to fit budget
4. System prompt always preserved
5. Token counts NOT available post-request (no actual usage from LiteLLM)

## Request/Response Metadata Available

### From Copilot Request
- `model.id`, `model.name`: Selected model
- `model.maxInputTokens`, `model.maxOutputTokens`: Budget
- `messages`: Full message history with roles
- `tools`: Available tool definitions
- `options.modelOptions`: User-specified parameters
- `options.configuration`: Provider configuration (baseUrl, apiKey)
- Model tags: `(model as any).tags[0]` - used to identify caller context

### From LiteLLM Response
- HTTP status & headers
- SSE chunks with delta text, tool calls, finish reason
- Response status (success/error)

### Captured in Telemetry
- `requestId`: Random 7-char ID
- `model`: Selected model ID
- `durationMs`: Wall-clock request time
- `tokensIn`, `tokensOut`: From options or estimated (NOT from actual response)
- `status`: "success", "failure", "caching_bypassed"
- `error`: Error message if failed
- `caller`: Model tag indicating context (inline-completions, terminal-chat, etc.)

## Configuration Management

### Location: `src/config/configManager.ts`

**Configuration Sources**:
1. **Provider Configuration** (v1.109+, encrypted by VS Code):
   - `baseUrl`: LiteLLM proxy URL
   - `apiKey`: API authentication token
   - Defined in `package.json` `languageModelChatProviders.configuration`

2. **Workspace Settings** (via `vscode.workspace.getConfiguration()`):
   - `litellm-connector.inlineCompletions.enabled`: Enable inline completions
   - `litellm-connector.inlineCompletions.modelId`: Model for inline
   - `litellm-connector.modelIdOverride`: Force model selection
   - `litellm-connector.disableQuotaToolRedaction`: Disable tool redaction on quota errors
   - `litellm-connector.modelOverrides`: Custom model tags
   - `litellm-connector.inactivityTimeout`: Connection timeout
   - `litellm-connector.disableCaching`: Bypass LiteLLM cache

**Legacy Migration**:
- `migrateToProviderConfiguration()`: Moves old secrets to new provider config format
- Backward compatibility with pre-1.109 users

## Dependencies Analysis

### No External Telemetry Currently
- `package.json` has NO PostHog, Datadog, or other telemetry libraries
- Current implementation is pure: logs to VS Code's output channel only
- Architecture ready for external integration (telemetry interface already designed)

### Key DevDependencies for Testing
- `sinon`: Mocking/stubbing
- `mocha`: Test framework (via vscode-test)
- `mocha-junit-reporter`, `mocha-multi-reporters`: Test reporting
- `typescript`, `eslint`, `prettier`: Linting/formatting
- `esbuild`: Production bundling
- `@vscode/test-cli`, `@vscode/test-electron`: Test runner

## Code Style & Conventions

### Naming
- Classes: PascalCase (`LiteLLMChatProvider`, `ConfigManager`)
- Methods/functions: camelCase
- Constants: UPPER_SNAKE_CASE
- Private members: `_leadingUnderscore`
- Interfaces/types: PascalCase

### Type Safety
- Strict TypeScript (`tsconfig.json` strict: true)
- No `any` in code (ESLint rules enforce this)
- Explicit return types on functions
- Type imports where possible

### Code Quality Principles (from AGENTS.md)
- Clean, readable at a glance
- Pure transformations separated from side effects
- Reusable helpers extracted
- Small, composable modules
- Consistent error handling
- 90%+ coverage targets (80%+ minimum, no regression > 1%)

### Error Handling
- Try-catch around HTTP calls with retries
- Graceful degradation (e.g., model override not in cache)
- User-facing error messages via Logger
- Sanitized error logging (no raw prompt echoes)

## Important Commands

### Development
- `npm run compile`: TypeScript typecheck
- `npm run watch`: Watch & rebuild
- `npm run lint`: ESLint (auto-fix)
- `npm run format`: Prettier format
- `npm run test`: Run unit tests
- `npm run test:coverage`: Tests + coverage report (targets 80%+ lines, 90%+ statements)

### Packaging
- `npm run vscode:pack:dev`: Debug VSIX
- `npm run vscode:pack`: Production VSIX
- `npm run package:marketplace`: Marketplace VSIX with custom README

### Other
- `npm run bump-version`: Semver bump
- `npm run download-api`: Update VS Code type definitions

## Testing Approach
- Unit tests for each module (one test file per source file)
- Sinon for mocking HTTP, VS Code APIs, Logger
- Test files organized by responsibility in `src/test/unit/`
- Coverage tracked via Istanbul/NYC (`coverage/` dir)
- CI runs `npm run test:coverage` to validate thresholds
