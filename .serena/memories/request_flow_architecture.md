# Request Flow Architecture

## High-Level Request Lifecycle

```
VS Code Copilot
      ↓
      ├─→ Chat Request → LiteLLMChatProvider.provideLanguageModelChatResponse()
      ├─→ Inline Completion → LiteLLMInlineCompletionProvider.provideInlineCompletionItems()
      └─→ Command → Various command handlers
           │
           ↓
    LiteLLMProviderBase (Shared Orchestration)
           │
           ├─→ 1. Validate & Build Request
           ├─→ 2. Discover/Cache Models
           ├─→ 3. Trim Messages to Budget
           ├─→ 4. Filter Unsupported Parameters
           │
           ↓
      LiteLLMClient (HTTP Transport)
           │
           ├─→ Endpoint Routing: /chat/completions, /completions, /responses
           ├─→ Rate Limiting & Retry Logic
           ├─→ Cache Control Headers
           │
           ↓
        LiteLLM Proxy
           │
           ↓
      LLM Provider (OpenAI, Anthropic, etc.)
           │
           ↓
      Response (SSE Stream)
           │
           ↓
    Response Parsing (Chat/Completions/Responses)
           │
           ├─→ Chunk parsing
           ├─→ Tool call buffering
           ├─→ Text accumulation
           │
           ↓
    Progress Callback
           │
           ├─→ Emit LanguageModelTextPart
           ├─→ Emit LanguageModelToolCallPart
           ├─→ Emit LanguageModelToolResultPart
           │
           ↓
         VS Code
```

## Request Entry Points

### 1. Chat Provider (Primary)
**File**: `src/providers/liteLLMChatProvider.ts`

**Method**: `provideLanguageModelChatResponse()`

**Input**:
- `model: LanguageModelChatInformation` - Selected model metadata
- `messages: LanguageModelChatRequestMessage[]` - Full conversation history
- `options: ProvideLanguageModelChatResponseOptions & { configuration? }`
  - `modelOptions: Record<string, unknown>` - Temperature, top_p, etc.
  - `tools: LanguageModelToolInformation[]` - Available functions
  - `toolMode: LanguageModelChatToolMode` - Auto/required/prohibited
  - `configuration: Record<string, unknown>?` - Provider config (baseUrl, apiKey)
- `progress: Progress<LanguageModelResponsePart>` - Callback to emit response parts
- `token: CancellationToken` - Cancellation support

**Flow**:
```
1. resetStreamingState() - Clear tool buffering
2. startTimer() - Begin telemetry timing
3. Generate requestId - Unique per request
4. Extract caller - From model.tags[0]
5. getConfig() or convertProviderConfiguration() - Get base URL & API key
6. buildOpenAIChatRequest() - Create OpenAI-format request
7. sendRequestToLiteLLM() - Execute HTTP call
8. processStreamingResponse() - Parse SSE stream
9. reportMetric() - Emit telemetry
10. Return to VS Code
```

### 2. Inline Completions Provider (Optional)
**File**: `src/inlineCompletions/liteLLMInlineCompletionProvider.ts`

**Method**: `provideInlineCompletionItems()`

**Input**:
- `document: TextDocument` - Current file
- `position: Position` - Cursor location
- `context: InlineCompletionContext` - Surrounding text
- `token: CancellationToken`

**Flow**:
```
1. getConfig() - Load base URL & API key
2. buildInlineCompletionPrompt() - Create completion prompt from context
3. trimTextToTokenBudget() - Fit to model's input budget
4. buildOpenAIChatRequest() - Convert to OpenAI format
5. sendRequestToLiteLLM() - Execute HTTP call
6. Extract completion text from response
7. Emit InlineCompletionItem[] - Return to VS Code
```

### 3. Commands
**File**: `src/commands/manageConfig.ts`, `src/commands/inlineCompletions.ts`

**Commands**:
- `litellm-connector.manage` - Open configuration UI
- `litellm-connector.inlineCompletions.selectModel` - Pick inline model
- `litellm-connector.showModels` - List discovered models
- `litellm-connector.reloadModels` - Clear cache & refresh

## Shared Orchestration Layer

### Base Class: `LiteLLMProviderBase`
**File**: `src/providers/liteLLMProviderBase.ts`

**Responsibilities**:
1. **Model Discovery** - `discoverModels(options, token)`
2. **Request Building** - `buildOpenAIChatRequest(messages, model, options, modelInfo, caller)`
3. **Parameter Filtering** - `stripUnsupportedParametersFromRequest(request, modelId)`
4. **Token Trimming** - `trimMessagesToFitBudget()` (via tokenUtils)
5. **Endpoint Routing** - `sendRequestToLiteLLM(requestBody, progress, token, caller, modelInfo)`
6. **Error Parsing** - `parseApiError(statusCode, text)`
7. **Capability Building** - `buildCapabilities(modelInfo)`
8. **Quota Detection** - `findQuotaErrorInMessages(messages)`, `detectQuotaToolRedaction()`

### Model Discovery Pipeline
```
discoverModels()
  ├─→ Check if base URL configured
  ├─→ LiteLLMClient.getModelInfo() - Fetch /model/info endpoint
  ├─→ Transform to LanguageModelChatInformation[]
  │   ├─ Add tags from model_info.tags or workspace config
  │   ├─ Build capabilities from model_info
  │   └─ Cache for 5 minutes
  ├─→ Return model list
  └─→ Store in _lastModelList for offline use
```

### Request Normalization Pipeline
```
buildOpenAIChatRequest()
  ├─→ 1. Validate Request
  │   ├─ Check model exists in cache
  │   ├─ Check configuration present
  │   └─ Check messages non-empty
  │
  ├─→ 2. Convert to OpenAI Format
  │   ├─ Chat: messages already in format
  │   └─ Completions: wrap prompt as user message
  │
  ├─→ 3. Extract Token Counts
  │   ├─ estimateMessagesTokens()
  │   ├─ estimateToolTokens()
  │   └─ Calculate total
  │
  ├─→ 4. Trim Messages
  │   ├─ trimMessagesToFitBudget()
  │   ├─ Preserve system message
  │   ├─ Keep recent context
  │   └─ Special handling for continuations
  │
  ├─→ 5. Filter Parameters
  │   ├─ Check KNOWN_PARAMETER_LIMITATIONS[model]
  │   ├─ Strip unsupported params
  │   └─ Log what was removed
  │
  ├─→ 6. Convert Tools
  │   ├─ convertTools() - OpenAI format
  │   └─ Detect quota tool redaction needs
  │
  └─→ 7. Return OpenAIChatCompletionRequest
```

### Supported Endpoint Routing
**Method**: `getEndpoint(mode?: string)`

- `/chat/completions` - Default for chat requests
- `/completions` - For simple completion prompts
- `/responses` - Alternative endpoint with different SSE format

**Selection Logic**:
- If `mode === "responses"`: Use `/responses` endpoint
- If request is simple completion: Try `/completions`
- Default: `/chat/completions`

## HTTP Transport Layer

### LiteLLMClient
**File**: `src/adapters/litellmClient.ts`

**Methods**:
- `getModelInfo(token?)` - Fetch available models
- `chat(request, mode?, token?, modelInfo?)` - Send chat/completion request
- `getHeaders(modelId?, modelInfo?)` - Build HTTP headers with User-Agent, Auth, Cache-Control
- `withNoCacheExtraBody(body)` - Add cache-bypass directives
- `fetchWithRateLimit()` - Handle 429 with exponential backoff
- `fetchWithRetry()` - Handle transient failures
- `parseRetryAfterDelayMs()` - Extract Retry-After header

**Header Construction**:
```
{
  "Content-Type": "application/json",
  "User-Agent": "litellm-vscode-chat/{version} VSCode/{version}",
  "Authorization": "Bearer {apiKey}",     // If apiKey configured
  "X-API-Key": "{apiKey}",               // Alternate header
  "Cache-Control": "no-cache",           // If disableCaching=true
  "no-cache": "true"                     // Extra body field for caching
}
```

**Error Handling**:
- 400: Check for unsupported parameter → Retry with stripped params
- 401/403: Authentication error → Log and fail
- 429: Rate limit → Exponential backoff with Retry-After
- 500+: Server error → Retry with backoff
- Network: Fetch failure → Retry with backoff

## Response Parsing

### For `/chat/completions` and `/completions`
**File**: `src/providers/liteLLMChatProvider.ts`

**Method**: `processStreamingResponse(stream, progress, token)`

**SSE Format Parsing**:
```
data: {"choices":[{"delta":{"content":"hello"}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"foo","arguments":"{\"a\""}}]}}]}
data: [DONE]
```

**Processing**:
1. Read SSE chunks from stream
2. For each delta:
   - If `content`: Emit `LanguageModelTextPart`
   - If `tool_calls`: Buffer until args are complete JSON
   - If complete tool call: Emit `LanguageModelToolCallPart`
3. Handle finish reason & tool redaction
4. Aggregate text for token counting (estimated)

### For `/responses` Endpoint
**File**: `src/adapters/responsesClient.ts`

**Method**: `sendResponsesRequest(request, progress, token, modelInfo)`

**Different SSE Format**:
```
event: content_block_start
data: {"type":"text","index":0}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}
```

**Processing**:
1. Parse event type & data
2. Aggregate text deltas
3. Parse tool calls from separate event stream
4. Emit response parts to progress callback

## Token Management

### Token Counting Strategy
**File**: `src/adapters/tokenUtils.ts`

**Algorithm**: Rough estimation, not actual
- Text: `Math.ceil(length / 4)` (4 chars ≈ 1 token)
- Tools: JSON stringified size / 4

**Why Estimates**:
- No `usage` field in LiteLLM streaming responses
- Actual counts would require post-request lookup
- Trade accuracy for latency

### Token Trimming Strategy
**Function**: `trimMessagesToFitBudget()`

**Algorithm**:
1. Reserve space for tools
2. Calculate safety limit (98% for Anthropic, 100% otherwise)
3. Always preserve system message
4. Add messages from newest to oldest until budget exhausted
5. Special case: "continue" requests preserve preceding assistant message

**Example**:
```
Budget: 100k tokens
Tools: 2k tokens
Available: 98k tokens

Messages (newest→oldest):
- User: "continue" (10 tokens) → MUST INCLUDE for context
- Assistant: "here's the solution..." (500 tokens) → PROTECTED for continuation
- User: "how do I...?" (20 tokens) → Include
- Tool: "here's tool output" (100 tokens) → Include
- User: "earlier question" (5000 tokens) → SKIP (would exceed budget)

Result: Drop oldest 3 messages, keep last 3
```

## Error Handling

### Retry Strategy
1. **Parameter Mismatch** (400 + "unsupported parameter"):
   - Strip optional params (temperature, top_p, frequency_penalty, presence_penalty, stop)
   - Retry once
   - If still fails, propagate

2. **Rate Limit** (429):
   - Exponential backoff (start: 100ms, max: 30s)
   - Parse Retry-After header
   - Max 3 attempts

3. **Transient Errors** (5xx):
   - Exponential backoff
   - Max 2 attempts

4. **Cancellation**:
   - Check token.isCancellationRequested
   - Clean abort signal propagation
   - Throw "Operation cancelled by user"

### Quota Error Detection
**Method**: `findQuotaErrorInMessages()`

**Detection**:
- Regex patterns: "quota", "rate limit", "insufficient credits", etc.
- Checks error messages in recent chat history
- Used to decide tool redaction

### Tool Redaction on Quota
**Method**: `detectQuotaToolRedaction()`

**Logic**:
- If quota error detected in history
- AND `disableQuotaToolRedaction=false` (default)
- Remove all tools from request to reduce token cost
- Log redaction event

## Metadata Available at Each Stage

### Stage 1: Request Entry
- `model`: ID, name, family, version, maxInputTokens, maxOutputTokens, capabilities
- `messages`: Role, content (text/image), tool results
- `options.modelOptions`: User-specified temperature, etc.
- `options.tools`: Function definitions
- `options.configuration`: baseUrl, apiKey
- `caller` (extracted): Model tag indicating context

### Stage 2: After Model Lookup
- `modelInfo`: Support flags (vision, tool_calling, streaming)
- `modelInfo.max_input_tokens`: Actual token limit
- `modelInfo.litellm_provider`: Provider name (openai, anthropic, etc.)
- `modelInfo.supported_openai_params`: Allowed parameters

### Stage 3: After Trimming
- Trimmed message set (subset of original)
- Actual message token count (estimated)
- Tool token count
- Remaining budget

### Stage 4: After Filtering
- Final request parameters (some may be stripped)
- Redaction applied? (tools removed for quota?)

### Stage 5: After HTTP Response
- `duration`: Wall-clock request time
- Response status code & headers
- Stream chunks (delta text, tool calls)
- Finish reason
- **NOT available**: Actual token counts from LiteLLM (not provided in API)

### Stage 6: Telemetry
```
{
  requestId: "abc1234",
  model: "gpt-4o",
  durationMs: 1500,
  tokensIn: 450,        // estimated from trimmed messages
  tokensOut: 200,       // estimated from response text
  status: "success",
  caller: "terminal-chat",
  // error?: "..." (if failed)
}
```

## Key Implementation Files Summary

| File | Responsibility |
|------|---|
| `extension.ts` | Activation, provider registration, command setup |
| `liteLLMProviderBase.ts` | Model discovery, request building, endpoint routing |
| `liteLLMChatProvider.ts` | Chat protocol, streaming, tool buffering |
| `liteLLMCompletionProvider.ts` | Completion prompts, text extraction |
| `liteLLMInlineCompletionProvider.ts` | Inline completions context building |
| `litellmClient.ts` | HTTP transport, retry logic, rate limiting |
| `responsesClient.ts` | Alternative `/responses` endpoint |
| `tokenUtils.ts` | Token estimation, message trimming |
| `configManager.ts` | Config/secret retrieval, migration |
| `logger.ts` | Centralized logging |
| `telemetry.ts` | Metric collection & reporting |
| `modelUtils.ts` | Model capability checks (vision, Anthropic, etc.) |
