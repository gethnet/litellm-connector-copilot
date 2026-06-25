# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [2.1.8] - 2026-06-24

### 🧹 Chores

* **📦 TypeScript 6 upgrade**: Upgraded from TypeScript 5.x to TypeScript 6.0.3 (with `@types/node` ^26.0.1, `typescript-eslint` ^8.62.0). The upgrade brings modern TypeScript features while maintaining full compatibility with the codebase. (`package.json`)

### 🚀 Features

* **💭 Full Anthropic thinking/thinking content coverage**: Added support for:
  - `signature` (encrypted thinking signature) emitted on last `content_block_delta` when `display: "omitted"`
  - `redacted_thinking` content blocks emitted via `content_block_start` with `redacted: true`
  - `display` metadata preservation (`"summarized"` vs `"omitted"`) throughout the streaming path
  - Thinking blocks now emit with proper metadata for multi-turn Anthropic tool-use flows, preserving reasoning continuity
  - `thinking_blocks` round-trip preservation in Responses Adapter for multi-turn flows
* **🔢 Token accounting correctness**: Fixed `normalizeUsagePayload` to not zero-out `reasoning_tokens` when only `output_token_details` exists without an explicit value. Upstream `reasoning_tokens` now correctly flows through to telemetry.
* **📊 Reasoning effort object format**: Added support for `{ effort: string; summary?: string }` format in `reasoning_effort`, enabling `gpt-5.4+` and OpenAI Responses API summary control (`"auto" | "concise" | "detailed"`)

### 🧪 Tests

* **Anthropic thinking block support**: Added 5 tests covering `content_block_start` (thinking type), `content_block_start` with `display: summarized`, `content_block_start` with `redacted=true`, `content_block_delta` with `signature_delta`, and display metadata preservation in `output_reasoning.delta`.
* **Token capture regression tests**: Added 3 tests verifying redacted/signature-only thinking parts don't advance local reasoning buffer, and that upstream `reasoning_tokens` from `response.completed` overrides local zero estimates.

### 🧹 Chores

* **📦 Version bump to `2.1.8-dev1`**: Started development cycle for thinking content coverage. (`package.json`)

## [2.1.7] - 2026-06-24

### 🐛 Fixes

* **🛡️ Stop redacting `insert_edit_into_file` on the first turn of every session (bug [#106](https://github.com/gethnet/litellm-connector-copilot/issues/106))**: Quota detection now only redacts on **high-confidence** matches — a real `LanguageModelToolResultPart` whose `callId` resolves to a redactable tool name. The previous regex-pair detector matched Copilot's own `<reminderInstructions>` scaffolding (which describes quota handling as guidance to the model) and stripped file-edit tools on every turn, even when no actual quota error had occurred. A low-confidence branch still logs a DEBUG trace and **does not** mutate the request or emit a fake `quota_exceeded:<tool>` failure event into telemetry, eliminating the noisy PostHog signal. (`src/providers/liteLLMProviderBase.ts`, `src/providers/base/requestBuilder.ts`, `src/providers/base/types.ts`)

### 🧪 Tests

* **High-confidence redaction coverage**: Updated the redaction tests to cover high-confidence `LanguageModelToolResultPart` matches, wrapper-only false positives (`<reminderInstructions>`-style echoed text), and non-redactable tool results. The detector is now verified to leave the tool list alone when only prompt scaffolding references the tool name. (`src/providers/test/liteLLMProviderBase.test.ts`)
* **Request builder fixtures**: Adjusted request builder test fixtures for the new confidence field on the redaction result so the pipeline stays deterministic. (`src/providers/test/liteLLMProviderBase.requestBuilder.test.ts`)

### 🧹 Chores

* **📦 Version bump to `2.1.7`**: Promoted the package from `2.1.6` to `2.1.7` to ship the redaction fix. (`package.json`)

## [2.1.6] - 2026-06-21

### 🐛 Fixes

* **🔧 String `category` on registered models (bug [#104](https://github.com/gethnet/litellm-connector-copilot/issues/104))**: `LanguageModelChatInformation.category` is now always a string (`'lightweight' | 'versatile' | 'powerful' | undefined`) emitted by the LiteLLM provider registry. Previously the registry set only the grouping object, which crashes VS Code's chat model picker (`getCategoryLabel`) with `TypeError: a.charAt is not a function` when its `default:` switch branch tries to call `.charAt` on the non-string value. With Copilot quota exhausted and BYOK models as the only viable option, this crash aborted `buildModelPickerItems()` and prevented the dropdown from ever opening. Per-backend picker section grouping is now driven by the existing vendor / id lookup rather than the `category` slot, so the picker continues to bucket models by backend. This is a workaround; the proper fix remains upstream in `microsoft/vscode` (add a `typeof === 'string'` guard in `getCategoryLabel`'s `default:` branch). (`src/providers/liteLLMProviderRegistry.ts`)
* **🧠 Picker category derivation from capabilities**: Added `derivePickerCategory()` to map a model's derived capabilities to one of VS Code's three supported tags. `powerful` when reasoning is supported or the context window is ≥ 200k tokens, `versatile` when tools or vision are supported, `lightweight` for small-context models without tools/vision/reasoning, and `undefined` (never `null`, never an object) when no signal is conclusive. Decision order is `powerful` > `versatile` > `lightweight` > `undefined`. The helper is pure, deterministic, and has no I/O. (`src/utils/modelCapabilities.ts`)

### 🧪 Tests

* **`derivePickerCategory` branch coverage**: Added 6 unit tests covering each tier (lightweight / versatile / powerful / undefined), the large-context-window short-circuit, and a regression guard that the helper never returns `null` or a non-string value. (`src/utils/test/modelCapabilities.test.ts`)
* **Registry `category` integration tests**: Added 4 integration tests asserting the registry emits `'versatile'` for balanced tools+vision models, `'powerful'` for reasoning-capable models, `'lightweight'` for small non-tooling models, and filters out the `'unknown model_name'` fallback so it never reaches VS Code. The existing per-backend grouping test continues to pass — we did not touch the grouping object. (`src/providers/test/liteLLMProviderBase.modelDisplay.test.ts`)

### 🧹 Chores

* **📦 `npm run check` script + version bump to `2.1.6`**: Added a top-level `check` script that chains lint, format, and coverage tests, giving a single command to validate the full pre-release gate. Bumped `package.json` to `2.1.6`. (`package.json`)
* **🧼 Workspace metadata cleanup**: Removed the unused DeepWiki MCP server entry from `.vscode/mcp.json` and refreshed the investigative agent's tool list to match the current dev container. This keeps workspace metadata aligned with the actual setup. (`.vscode/mcp.json`, `.github/agents/investigative agent.agent.md`)

## [2.1.5] - 2026-06-17

### 🐛 Fixes

* **🔧 forceResponsesEndpoint default corrected to opt-in (bug [#102](https://github.com/gethnet/litellm-connector-copilot/issues/102))**: The hidden configuration flag `litellm-connector.forceResponsesEndpoint` now defaults to `false`, requiring explicit user opt-in. Previously, this flag was introduced in v2.1.0 with an unintended `true` default, causing all models to route through the `/responses` endpoint when `enableResponsesApi` was enabled — even without the user explicitly setting the flag. Hidden config flags should follow the principle of least surprise; they must not change default routing behavior unless explicitly enabled. (`src/config/configManager.ts`)

### 📚 Documentation

* **🧾 Updated JSDoc for forceResponsesEndpoint**: Clarified that the flag is opt-in, JSON-only, and not exposed in the Settings UI. (`src/types.ts`)

## [2.1.4] - 2026-06-17

### 🐛 Fixes

* **🔧 Bedrock tool result formatting validation (bug [#100](https://github.com/gethnet/litellm-connector-copilot/issues/100))**: Added strict validation and diagnostic logging for tool result message format to ensure compatibility with Bedrock's Converse API. Tool result IDs are now validated to contain only alphanumeric characters, dashes, and underscores, and content is verified to be non-empty. When a tool result message fails format validation, diagnostic warnings are logged to aid troubleshooting without blocking the request. This prevents `BedrockException: Expected toolResult blocks` errors when using Bedrock backends with multi-turn conversations involving tool calls. (`src/adapters/messageConverter.ts`)

### 🧪 Tests

* **Tool result ID preservation and Bedrock compatibility**: Added comprehensive test suite validating tool result message format compliance, including ID normalization, message ordering, format validation for Bedrock-compatible character patterns, sequential tool call/result pairs, and content defaulting to "Success" for empty results. (`src/adapters/test/messageConverter.test.ts`)

## [2.1.3] - 2026-06-16

### 🐛 Fixes

* **🖼️ Image content serialization in `/responses` requests (bug [#98](https://github.com/gethnet/litellm-connector-copilot/issues/98))**: `image_url` content items in user and assistant messages are now correctly wrapped in an array before being sent to the `/responses` endpoint. Previously they were passed as a bare object, causing Azure (and other strict backends) to reject requests with `Invalid type for 'input[N].content': expected one of an array of objects or string, but got an object instead`. This failure was most visible in `inline-edit` sessions that include editor screenshots alongside a large conversation context. (`src/adapters/responsesAdapter.ts`)
* **⚡ Incomplete stream recovery**: The provider now attempts a best-effort recovery when a stream ends without a `[DONE]` marker. Buffered `/responses`-format tool calls, anonymous tool calls, and OpenAI tool calls are flushed and emitted rather than silently dropped. A partial response is returned to VS Code instead of hard-failing. (`src/providers/liteLLMChatProvider.ts`, `src/adapters/streaming/liteLLMStreamInterpreter.ts`)
* **🔇 Clean SSE closure handling**: SSE streams that close cleanly without buffered data are no longer treated as errors. Only genuinely truncated streams (data remains in the buffer) raise an error, producing clearer diagnostics for long-running proxy responses. (`src/adapters/sse/sseDecoder.ts`)

### 🧪 Tests

* **Regression coverage for bug #98**: Added an end-to-end inline-edit scenario test that builds a multi-turn conversation containing image content, tool invocations, and `reasoning_effort`, and asserts that no `message`-type input item produced by the adapter carries bare-object `content`. (`src/adapters/test/responsesAdapter.test.ts`)
* **Buffered tool call recovery**: Added unit tests for `flushPendingBuffers()` covering `/responses`-format, anonymous, and OpenAI tool call flushing on incomplete streams, malformed arg recovery, and empty buffer handling. (`src/adapters/streaming/test/liteLLMStreamInterpreter.test.ts`)
* **SSE clean closure / truncation detection**: Added regression tests for clean no-`[DONE]` termination (no error) and truncated buffer detection (explicit error). (`src/adapters/sse/test/sseDecoder.test.ts`)
* **Provider-level incomplete stream recovery**: Added chat provider tests verifying best-effort recovery is attempted on stream-end errors and that previously buffered tool calls are emitted to VS Code. (`src/providers/test/chatProvider.test.ts`)

## [2.1.2] - 2026-06-16

### ✨ Features

* **🖼️ Multimodal Content Preservation**: The `/responses` adapter now preserves `image_url` items when converting user and assistant chat messages, allowing multimodal prompts to pass through instead of dropping image content. System messages with content arrays are now supported by joining text items into request instructions. (`src/adapters/responsesAdapter.ts`, `src/types.ts`)

### 🚀 Performance & Memory

* **🧼 LRU Token Cache**: Replaced unbounded token count cache with LRU (Least Recently Used) cache capped at 100 entries. Reduces collection growth by **96%** (2,500 → 100 entries per 500 turns). (`src/utils/lruCache.ts`)
* **🧼 Bounded Audit Trail**: Added FIFO eviction to audit trail events, capping at 50 entries maximum. Reduces audit event accumulation by **97.5%** (2,000 → 50 entries per 500 turns). (`src/observability/auditTrail.ts`)
* **🧼 Orphan Request Timeout**: Added 5-second orphan timeout guard in token counting promises to clean up stuck pending requests. Reduces pending request count by **33%** (~1,500 → ~1,017 entries per 500 turns). (`src/providers/liteLLMProviderBase.ts`)
* **🧼 Lifecycle Cleanup**: Extension now calls `clearSessionCaches()` on deactivation to reset caches on reload, ensuring clean session starts. (`src/extension.ts`)
* **📊 Collective Impact**: All 4 memory fixes reduce total collection accumulation by **80.5%** (6,000 → ~1,167 entries per 500 turns) and cap long-session memory growth to **~14-15 MB** even at 1000+ turns (vs **21+ MB** unbounded). Stabilizes agentic sessions 500+ turns without GC pauses or hangs.

### 🐛 Fixes

* **SSE stream incomplete-response handling**: SSE streams that close without a `[DONE]` marker now throw an explicit error instead of silently completing with zero response parts. This prevents the retry loop and surfaces incomplete responses clearly to VS Code. Affects `/chat/completions` and `/responses` endpoints. (`src/adapters/sse/sseDecoder.ts`, `src/providers/liteLLMChatProvider.ts`)
* **Text array content parsing in responses adapter**: Now correctly reads `content[].text` only from `{ type: "text" }` items when building response instructions, preventing non-text payloads from being misparsed. (`src/adapters/responsesAdapter.ts`)
* **Chat request failure diagnostics**: Improved error logging to include full chat request error details (name, message, stack, root cause, caller, and stage), making failures easier to diagnose. Unified telemetry event from `request.fetch_failed` to `request.failed` for more complete context. (`src/providers/liteLLMChatProvider.ts`)

### 🧪 Tests

* Added `LRUCache` utility with 8 comprehensive unit tests covering eviction, access ordering, and edge cases. (`src/utils/test/lruCache.test.ts`)
* Added new audit trail test for bounded entries enforcement and FIFO eviction correctness. (`src/observability/test/auditTrail.test.ts`)
* Enhanced memory profile integration test to simulate all 5 bounded collection phases with realistic 500-turn load. (`src/test/integration/memoryProfile.test.ts`)
* Added unit coverage for user and assistant image content preservation in responses adapter. (`src/adapters/test/responsesAdapter.test.ts`)
* Added comprehensive integration coverage for the mock backend across lifecycle, endpoints, streaming, tool calls, latency, errors, and concurrent requests. Hardened cancellation coverage to verify immediate aborts before `fetch` is called. (`src/test/integration/mockLiteLLMBackend.test.ts`, `src/test/integration/cancellation.test.ts`)

### 🧹 Chores

* Downgraded heuristic tokenizer logs from debug to trace verbosity so token counting stays available without cluttering normal debug output. (`src/adapters/tokenizers/heuristicTokenizer.ts`)

## [2.1.1] - 2026-06-12

### 🐛 Fixes

* **Reasoning effort parameter gating**: Models that advertise `supports_reasoning: true` but don't include `reasoning_effort` in their `supported_openai_params` no longer show the effort picker (previously caused rejected requests and retry loops). The `reasoning_effort` parameter is now properly gated behind `isParameterSupported` checks in request builders.
* **"none" effort handling fixed**: When reasoning effort falls through to `"none"` as a fallback value, the field is now omitted from the request entirely rather than setting it to `"none"` (which was also rejected by some backends).
* **Reasoning content support**: Stream interpreter now correctly handles `delta.reasoning_content` from chat-completions responses (used by Qwen3, llama.cpp, and other models that emit reasoning via this field).
* **Merge reasoning content flag**: Added `merge_reasoning_content_in_choices` flag to control whether `reasoning_content` is emitted as separate thinking parts or merged into content for compatibility.

## [2.1.0] - 2026-06-10

### 💥 Breaking / Behavior Changes — READ BEFORE UPGRADING

> ⚠️ **Configuration has fundamentally changed in this release.** If you were using the old workspace-settings approach (`litellm-connector.baseUrl`, `litellm-connector.backends`, `litellm-connector.apiKey`), those settings are **gone**. The extension now uses VS Code's built-in **Language Models provider-group** UI (VS Code 1.120+) as the sole configuration path.
>
> **What to do if things go sideways after upgrading:**
> 1. Run **`LiteLLM: Reset All Configuration`** from the Command Palette to clear any stale state.
> 2. Open VS Code's **Language Models** settings panel (Settings → Language Models, or via `LiteLLM: Manage Configuration`).
> 3. Add a new LiteLLM provider group with your base URL and API key.
> 4. If you had multiple backends, add one provider group per backend.
> 5. After saving, wait a moment for model discovery to complete, or run **`LiteLLM: Reload Models`**.
>
> **The automatic migration** runs on first activation and attempts to move your old secrets/settings into the new provider-group format via a guided notification. If that prompt is dismissed or fails, follow the manual steps above.

* **Removed Legacy Workspace-Settings Configuration**: The `litellm-connector.baseUrl`, `litellm-connector.backends`, and `litellm-connector.apiKeySecretRef` workspace settings have been removed. Configuration now comes exclusively from VS Code 1.120+ per-group provider configuration via the `languageModelChatProviders` contribution point.
* **Removed `litellm-connector.checkConnection` command** and its menu entries. Use `LiteLLM: Reload Models` to verify discovery is working.
* **Removed Legacy ConfigManager Methods**: `setConfig()`, `addBackend()`, `removeBackend()`, `updateBackend()`, `listBackends()`, `isConfigured()`, `cleanupAllConfiguration()`, and `resolveBackends()` have been removed from `ConfigManager`.
* **Removed Legacy Type Fields**: `LiteLLMConfig.url`, `.key`, and `.backends` fields have been removed. The `LiteLLMBackend` and `ResolvedBackend` interfaces have been deleted.
* **Git commit generation and inline completions now require `commitModelIdOverride`** to be set explicitly in settings. They no longer auto-detect a model. The previous 2.0.0 temporary limitation is now codified as the permanent behavior.

### ✨ Features

* **Automatic Legacy Config Migration**: On first activation after upgrading, the extension detects old workspace-settings / `SecretStorage` configurations and shows a guided notification to help you migrate to the new provider-group format. Migration state is tracked so the prompt only appears once. (`src/config/legacyConfigMigration.ts`)
* **Per-Group Isolation**: Each configured provider group gets its own model discovery state. Multiple LiteLLM backends no longer share or bleed state between groups.
* **Model Override Master Toggle** (`litellm-connector.enableModelOverrides`): A new boolean setting lets you disable all override rules and rely purely on `/model/info` from the LiteLLM proxy. Useful when proxy-reported capabilities are accurate.
* **Tool Name Sanitization for Bedrock**: Tool names are automatically sanitized for Bedrock-compatible providers that reject non-alphanumeric characters.
* **Tool Call ID Normalization**: Tool call IDs are normalized to ≤40 characters for strict providers (e.g., GPT-5 / o-series).
* **Image & PDF Token Estimation**: Token budget calculation now estimates tokens consumed by image and PDF data parts (closes #76).
* **Discovery Backoff**: Repeated model discovery failures now trigger an exponential backoff to prevent hammering a proxy that is down.
* **Structured Logging Guidance**: `StructuredLogger` now has a documented per-level decision table so log noise is consistent and predictable.
* **Audit Trail / Prompt Audit Tooling**: Added hook system for observability, including a PostHog hook and an audit trail for prompt and response inspection.

### 🛠️ Refactors

* **BackendRegistry Owns Discovery**: `ModelDiscovery` has been merged into `LiteLLMProviderRegistry`. The registry is now the single source of truth for backends and their associated models, with a **public read, internal write** contract. `discoverModels(options, token)` is the only public ingress for populating the registry; internal write methods are now `private`. The base provider subscribes to the registry's `onDidChange` event and forwards to VS Code's `onDidChangeLanguageModelChatInformation`.
* **Provider Base Split**: The provider base was split into dedicated discovery, request, and transport service layers under `src/providers/base/` for clearer single-responsibility boundaries.
* **Streaming Interpreter Unified**: `/responses` stream event handling has been migrated into the shared `LiteLLMStreamInterpreter` so both the chat provider and responses adapter share one stream-parsing path.
* **TypeScript Strict Typing**: Broad `any` elimination pass across adapters, config, providers, and tests. All new code conforms to the `typescript-no-any` rule.

### 🐛 Fixes

* **Streaming abort on cancellation**: Streaming requests are now correctly aborted when the user cancels or the inactivity timeout fires.
* **Reasoning effort preserved across refreshes**: Selected reasoning effort is no longer reset when model discovery refreshes the picker.
* **Sparse tool capability detection fixed**: Models with partial tool-capability indicators are now detected correctly.
* **Provider group names derived from base URLs**: When no explicit name is provided, provider group labels are derived from the base URL for clearer picker display.

### 📊 Telemetry & Observability

* **Centralized streaming token capture**: Token usage is captured in one place across the streaming path and reported consistently.
* **Enriched token usage reporting**: Input, output, and reserved output budgets are all reported in telemetry events.
* **Commit generation routing telemetry**: Token usage and routing decisions during commit message generation are now captured.
* **Tokenizer observability**: Tokenizer selection and fallback events are logged for diagnosability.

### 🧪 Tests

* Broadened coverage across streaming, observability, and activation flows.
* Expanded `messageConverter` coverage.
* Refactored transport tests for clarity and improved configuration handling coverage.

### 🧭 Migration Guide (Legacy → 2.1.0)

If you were using any of the following **old workspace settings**, they no longer exist:

| Old Setting | Action |
|---|---|
| `litellm-connector.baseUrl` | Add a provider group in the Language Models UI |
| `litellm-connector.backends` | Add one provider group per backend |
| `litellm-connector.apiKey` / `apiKeySecretRef` | Enter API key when adding a provider group |

**Step-by-step:**
1. After upgrading, watch for the **migration notification** on startup — it will guide you through re-entering your backends.
2. If you dismiss it or need to redo it: open **Command Palette** → **`LiteLLM: Manage Configuration`** → follow prompts.
3. If you get stuck: **`LiteLLM: Reset All Configuration`** clears everything so you can start fresh.
4. Verify with **`LiteLLM: Reload Models`** — your models should appear in the picker grouped by backend name.

## [2.0.1] - 2026-05-14

### 🧭 Improvements

* **Modern Provider-Group Config**: The extension now detects VS Code per-group provider configuration during model discovery and treats it as the preferred configuration path.
* **Legacy Prompt Suppression**: Once modern provider configuration is validated, the extension suppresses legacy configuration prompts for the rest of the session.
* **Model Picker Grouping**: Discovered models now carry backend category metadata so multi-backend groups stay visually separated in the picker.

### 📊 Telemetry & Validation

* **Configuration-Flow Telemetry Refresh**: Added telemetry hooks around modern configuration detection so activation and discovery flows can be tracked more accurately.
* **Regression Coverage**: Added and updated tests for provider discovery, telemetry behavior, and extension activation/integration paths.

## [2.0.0] - 2026-05-13

### 💥 Breaking / Behavior Changes

* **VS Code 1.120+ Baseline**: The extension now targets the VS Code 1.120 Language Model provider surface as the primary path for model discovery and response-part handling.
* **Modern Provider Config First**: Discovery now prioritizes per-group provider configuration (`options.configuration`) and only falls back to extension-managed backends when provider configuration is missing/incomplete. This modern provider-group path is the preferred configuration path for full VS Code feature alignment.
* **Provider Config Validation Tightened**: Provider-group conversion now requires a non-empty provider/group name, `baseUrl` starting with `http://` or `https://`, and a non-empty `apiKey`.
* **Manage Command Behavior Changed**: `litellm-connector.manage` now routes directly to multi-backend management instead of prompting a legacy single-backend setup flow.

### ✨ Features

* **Unified Chat Provider Path**: Consolidated chat behavior around the VS Code 1.120 rich response-part flow (text/thinking/data/tool-call emission path hardening and shared orchestration improvements).
* **Modern Grouped Discovery**: Added and expanded session-based discovery primitives (`BackendSession`) so model identities and picker grouping remain isolated by configured provider/group.
* **Auto-Refresh After Config Changes**: Added a debounced `workspace.onDidChangeConfiguration` refresh hook that clears the model cache so Language Models UI updates after configuration changes.
* **Reasoning Overrides + Fallbacks**: Added regex-based reasoning capability overrides and retry/fallback behavior for reasoning-effort handling.
* **Model Override Registry**: Added `src/config/modelOverrides.ts` + `modelOverrides.json` with test coverage for structured override loading.

### 🛠️ Fixes & Refactors

* **Runtime Guard Hardening**: Tightened runtime checks across clients/providers/telemetry and removed unsafe cast-heavy paths.
* **Discovery Flow Cleanup**: Refactored provider-base discovery into clearer modern-session and backend-fallback branches.
* **Command/UI Reliability**: Improved backend-management UX details (focus behavior, trimmed inputs, command copy) and aligned activation prompts to configuration management flow.
* **Type Safety Improvements**: Broader strict typing cleanup across adapters, config, providers, utility helpers, and tests.

### 🧪 Tests & Validation

* Expanded regression and unit coverage across:
  * provider discovery/grouping/model-display behavior
  * extension activation/configuration refresh behavior
  * config conversion/validation and model override resolution
  * responses/message conversion and token/capability handling

### 📚 Documentation

* Updated both README variants to align setup guidance with modern provider-group behavior, backend identity grouping, and updated command semantics.

### ⚠️ Known Risks / Follow-ups

* **Broad Refresh Trigger Scope**: The config-change refresh hook currently reacts to all workspace configuration changes; it may refresh more often than necessary and could be narrowed to relevant keys later.
* **Temporary Feature Limitation (2.0.0)**: Unless manually configured, **git commit message generation** and **inline completions** may be inoperative in this release while modern-config parity work is completed.
* **Modern-Only Parity Audit Pending**: Commit-message and inline-completion paths still have legacy/fallback touchpoints; validate strict modern-only configuration parity before declaring migration complete.
* **No-Auth Proxy UX**: Modern provider validation now requires `apiKey`; environments that intentionally run without auth may need an explicit UX strategy if this should remain supported.

## [1.6.3] - 2026-04-30

### 🐛 Fixes

* **Cache Control Handling**: Suppressed `cache_control` data parts at the VS Code streaming boundary and nested tool-result conversion paths, preventing `application/vnd.cache-control+json` carrier objects from being re-emitted into future LLM input while preserving legitimate text mentions for debugging and code generation.

### 🧪 Tests

* Replaced the streaming regression test that previously codified cache-control carrier pass-through with suppression coverage, plus guards for non-cache-control data parts and tool-result metadata stripping.

## [1.6.2] - 2026-04-28

### ✨ Features

* **V2 Responses Pipeline**: Overhauled the V2 responses conversion and validation to handle `LanguageModelDataPart`, `LanguageModelThinkingPart`, and other VS Code internal carrier objects properly.

### 🐛 Fixes

* **Streaming Error Logging**: Improved streaming error logging and telemetry to capture more granular details on connection drops and parse failures.
* **Cache Control Handling**: Dropped `cache_control` metadata from transport and token counting to prevent `{"$mid":24,"mimeType":"cache_control","data":"ZXBoZW1lcmFs"}` carrier objects from corrupting prompts or inflating the token budget.

## [1.6.1] - 2026-04-23

### ✨ Features

* **Model Display Labels**: Added `ExtendedModelInformation` type and `formatModelDisplayLabel` helper to centralize model UI labeling and vendor display.
* **Provider Metadata**: Updated `LiteLLMProviderBase` to expose `rawModelName`, `vendor`, `backendName`, `tooltip` and `detail` so consumers render consistent model info.
* **Token Normalization**: Normalized provider handling and token fields by using `providerLower` for family derivation and `derived.maxInputTokens` for maxInputTokens.

### 🐛 Fixes

* **Post-Session Scripts**: Updated post-session validation message to recommend running `npm run format` and `npm run lint` (removed `:check` variants) so commands match current scripts.

### 🧹 Chores & Tests

* Bumped package.json version to 1.6.1-dev5.
* Adjusted unit tests to validate new display label formatting and backendName/description values.

## [1.6.0] - 2026-04-12

### 🎊 New Features

* 🌍 **Multi-Backend Aggregation**: Connect to multiple LiteLLM instances simultaneously (e.g., Local Llama + Cloud GPT-4 + Internal Proxy). Models from different backends are automatically namespaced (e.g., `cloud/gpt-4o`, `local/llama-3`) and appear in the model picker with clear backend labels.
  - New `MultiBackendClient` adapter handles routing, discovery, and request dispatch across backends.
  - New `litellm-connector.backends` configuration setting with full add/edit/remove/toggle UI via **Manage Multiple Backends** command.
  - Legacy single-backend configuration (`baseUrl`/`apiKey`) auto-migrates to `backends[0]` transparently.

* 📊 **PostHog Telemetry & Observability**: Non-identifiable data collection with opt-in/opt-out via `vscode.env.isTelemetryEnabled`.
  - `TelemetryService` with typed capture methods for request lifecycle, feature usage, errors, and model usage.
  - `PostHogAdapter` (Node) and `PostHogAdapter` (Web) implementing `IPostHogAdapter` interface.
  - `PostHogHook` bridges the v2 observability `HookSystem` to PostHog telemetry events.
  - Automatic enrichment of every event with `distinctId`, `extension_version`, `vscode_version`, `ui_kind`, `os`.
  - Aggregated feature usage reporting on 15-minute intervals to reduce noise.
  - Sourcemap upload script for PostHog error symbolication.

* 🔧 **Model Capability Overrides**: Manually override VS Code's capability detection (`toolCalling`, `imageInput`) when LiteLLM's auto-detection is incorrect. Configure via `litellm-connector.modelCapabilitiesOverrides` setting with comma-separated values (e.g., `"toolCalling, imageInput"` or `"tools, vision"`).

* 🧠 **V2 Chat Provider (Experimental)**: Supports VS Code's newer Language Model APIs including `LanguageModelThinkingPart` for reasoning/thinking models. Emits structured text, thinking, data, and tool-call parts to the progress callback.

* ✍️ **Multi-Repo Commit Message Generation**: `generateCommitMessage` command now correctly identifies the active repository via SCM `rootUri`. Works reliably in multi-repo workspaces.
  - Added `rootUri` to `Repository` interface in `GitUtils`.
  - Added `findRepositoryByRootUri` to `GitUtils` for precise repository matching.
  - Updated `generateCommitMessage` command to use the correct repository for both diff retrieval and input box updates.

### 🛠️ Bug Fixes

* 🛠️ Keep commit-message generation failures visible in both local logs and telemetry.
* 🧭 Propagate request IDs through PostHog request telemetry for better event correlation.
* ⚙️ Fixed undefined silent flag which blocked the ability to configure litellm as a new instance.
* 🛠️ Fixed issues with the nuke command leaving stale models behind when resetting user configuration.
* 🛠️ Stabilized telemetry ID and re-scoped unhandled exception detection and handling to be properly aligned with best practices.

### 📊 Telemetry & Observability

* 🛠️ Add telemetry feature-usage reporting for chat, completions, inline completions, commit generation, and model picker usage.
* 🔔 Capture feature toggle snapshots and toggle-change events from config changes so opt-in behavior is visible in telemetry.
* 🧭 Extend telemetry exception capture with caller context and add tests for the new feature-usage events.

### 🧩 Configuration & Commands

* ⚙️ `ConfigManager` now reports feature-toggle state after config changes.
* 🚦 Telemetry wired into model-management and reset/check commands for consistent tracking.
* 📝 Feature-usage snapshot emitted during extension activation after configuration loads.
* New `litellm-connector.backends` setting for multi-backend configuration (array of `{name, url, apiKeySecretRef, enabled}`).
* New `litellm-connector.modelCapabilitiesOverrides` setting for per-model capability overrides.

### 🧪 Testing & Validation

* ✅ Multi-repo regression tests for `GitUtils` and `generateCommitMessage` command.
* ✅ `MultiBackendClient`, `ResponsesAdapter`, `TokenUtils`, `ConfigManager`, and telemetry service test coverage.
* ✅ PostHog adapter tests for both Node and Web, including disabled/pre-initialize paths.
* ✅ Model capability override tests for `capabilitiesToVSCode` and `getModelTags`.
* ✅ Shared test mocks (`createMockSecrets`, `createMockModel`, `createMockOutputChannel`) stabilized across test suites.
* ✅ Regression coverage for commit-provider exception reporting and request ID propagation in telemetry events.
* ✅ Coverage for `ConfigManager` feature-toggle reporting and `TelemetryService` feature event helpers.

### 🔧 Build & Tooling

* `package-marketplace.mjs` script for stripping proposals and swapping READMEs during VSIX packaging.
* `scripts/upload-posthog-sourcemaps.mjs` for PostHog error symbolication.
* `scripts/versionUtils.mjs` with shared semver parsing and bump logic.
* Post-session validation hook (`.github/hooks/post-session-validation.json`).
* Agent planning infrastructure (`plan-generation.instructions.md`, `Project Planner.agent.md`).
* CI workflow streamlined: combined lint/format/test into single step, upgraded Codecov to v6.


## [1.5.0] - 2026-03-20

### 🚀 Features
* Improve model discovery and refresh behavior (c18947f)
* Enhance diff handling and token counting (92120a8)
* Add token counting functionality and update agent tools (2ae2ad7)

### 🛠️ Bug Fixes
* GPT-5.3-codex Tool Calling Failure Fixes #54 (dc32107)
* Fix 400 Bad Request with gemini-3.1-flash-lite-preview (Invalid Role) #64
* Fix 400 UnsupportedParamsError for gpt-5* and o1-* models #65

### 🏠 Internal
* Refactor: improve logging architecture and cleanup (e8c75d2)
* Finalize project structure and improve streaming/observability (f931652)
* Investigate context window usage (#58) (7840e2b)
* Update agent and skills (f00a7a2)
* **StructuredLogger output channel renamed**: Renamed the output channel from "LiteLLM V2" to "LiteLLM Structured" to distinguish it from the legacy Logger channel and avoid confusion in the VS Code Output panel.
  - Updated corresponding test in `src/observability/test/structuredLogger.test.ts` to verify the correct channel name.

---

## [1.4.6] - 2026-03-11

### 🛠️ Bug Fixes
- **Model Discovery Throttling**: Fixed an issue where the extension could perform excessive `/model/info` lookups, particularly after upgrading to VS Code 1.111.
  - Implemented **in-flight deduplication** to prevent concurrent discovery requests from stacking.
  - Added a **30-second TTL cache** for background discovery requests.
  - Preserved immediate refresh behavior for manual "Reload Models" and configuration changes.
- **Stability**: Rewrote discovery tests to be deterministic and robust across local and CI environments.

### 🏠 Internal
- Added regression test suite `src/providers/test/discoveryThrottling.test.ts`.
- Improved type safety in provider orchestration logic.

---

## [1.4.4] - 2026-03-08

### ✨ Features
- Add LiteLLM-backed token counting with local estimation, background refinement, and short-lived caching for faster, more accurate budgeting.
- Improve diff handling with `compactDiff` to reduce prompt size before truncation.
- Enhance model discovery and refresh behavior so model changes are reflected more reliably in the UI.
- Add experimental V2 chat provider support for newer VS Code chat APIs, including V2 messages and thinking parts.
- Improve message conversion for `application/json`, `text/*`, and `cache_control` content handling.
- Expand model metadata and provider coverage for newer Anthropic, OpenAI, Vertex AI, and related configurations.

### 🐛 Fixes
- Fix GPT-5.3-codex tool-calling failures.
- Reduce truncation issues by compacting diffs before applying hard limits.
- Strip unsupported parameters more consistently for models such as `gpt-5-mini`.
- Preserve original error causes when rethrowing API and retry failures for clearer diagnostics.
- Sanitize commit-message and streamed text output by stripping markdown code fences.

### 🧹 Chores
- Refresh agent and skill definitions and expand investigative tooling.
- Tighten `.gitignore` patterns for VS Code type declaration files.
- Update CI workflows, artifact handling, and development dependencies.
- Raise the VS Code engine requirement and improve package metadata for discoverability.

---

## [1.4.2] - 2026-02-27

### ✨ Fixed
- **SCM-generation context overflow prevention**: Resolved a context overflow bug in SCM generation by implementing a flat 5% input-token safety buffer for all models. This prevents large diffs from inadvertently filling the entire context window. Inline completions were unaffected by this issue.

---

## [1.4.0] - 2026-02-26

### ✨ Features
- **Reset Configuration Command**: Added `litellm-connector.resetConfiguration` to allow users to quickly wipe provider settings and secrets, simplifying troubleshooting and environment switching.
- **Smart Diff Truncation**: The extension now uses model-specific token limits (`model.maxInputTokens`) to intelligently truncate git diffs. This prevents "context window exceeded" errors when generating commit messages or analyzing large changes.

### 🐛 Fixes & Improvements
- **Robust Parameter Filtering**: Improved handling for `o1` and `Claude` models by sanitizing payloads and stripping unsupported parameters that previously caused backend rejections.
- **Enhanced Documentation**: Added comprehensive troubleshooting sections to the marketplace and repository READMEs to help users resolve common connection and configuration issues.

### 🧹 Chores & Infrastructure
- **CI Stability**: Updated CI workflows to target the correct development branches and implemented skips for flaky network-dependent tests to ensure reliable build signals.
- **Clean Code**: Removed unused imports and refined test suites for better maintainability.

---

## [1.3.12] - 2026-02-23

### ✨ Added
- **📝 Conventional Commit Generation**: Generate elegant, Conventional Commits-compliant messages directly from the SCM view. Use the new `LiteLLM: Generate Commit Message` command to turn your diffs into clear documentation instantly.
- **🎯 Dedicated Model Selection**: Gain finer control with the new model picker for specific tasks. You can now override and select distinct models for commit generation and inline completions via the status bar or settings.
- **📊 Advanced Token Tracking & Telemetry**: Hardened token counting with a new `HeuristicTokenizer`. Monitor `tokensIn` and `tokensOut` with real-time telemetry, ensuring you stay within budget while enjoying human-readable model capability tooltips (e.g., "1M", "256K").
- **⚡ Stabilized Streaming Pipeline**: The streaming engine has been rebuilt with a dedicated `LiteLLMStreamInterpreter`. This resolves issues with fragmented server-sent events (SSE) and ensures a smoother, more reliable chat and completion experience.
- **🛠️ Connection Diagnostics**: Run the new `LiteLLM: Check Connection` command to instantly verify your setup and troubleshoot configuration issues.

### 🐛 Fixed
- **Reliable JSON Parsing**: Resolved a logic error in stream parsing that could cause chat failures.
- **Context Window Accuracy**: Models now correctly report and respect their `rawContextWindow` for better input trimming.
- **Error Handling**: Improved retry logic now provides descriptive messages for unsupported model parameters.
- **Type Safety**: A major refactor of the codebase and test suite has eliminated redundant type casts, leading to a more robust and maintainable extension.

### 🧪 Tests
- **85%+ Test Coverage**: Reorganized the test suite into modular subdirectories and implemented component-based tracking via Codecov.
- **Dev Container Hardening**: Now supports automatic SSH key mounting for seamless Git operations within development environments.

---

## [1.3.10] - 2026-02-11

### 🛠️ Bug Fixes
- **🧱 Tool-Call Hardening**: Improved compatibility with strict providers (like GPT-5.2) by ensuring all tool call IDs are normalized to ≤ 40 characters.
- **🧼 Smart Log Sanitization**: Provider error messages are now sanitized to strip echoed Copilot prompt context, keeping logs clean and readable.
- **🛡️ Stricter Quota Detection**: Tightened heuristics for tool redaction to prevent spurious "Quota Exceeded" errors from bricking active chat turns.
- **🌐 Web Compatibility**: Refactored internal hashing to remove Node.js built-in dependencies, ensuring full support for VS Code Web.
- **🤖 Agent Standards**: Updated AGENTS.md with new engineering standards for automated contributors.

---

## [1.3.9] - 2026-02-10

### ✨ Highlights
- **Completion support**: Adds a dedicated **text completions provider** for a smoother "type-ahead" experience.
- **Inline completions**: Introduces an **inline completion provider + registration flow**, bringing faster, more natural suggestions directly into the editor.
- **Cleaner provider architecture**: Refactors shared logic into a **common base orchestrator**, reducing duplication and keeping chat + completions behavior consistent.

### ⚙️ Configuration & UX Improvements
- **Model management commands** added to make configuration easier to inspect and adjust.
- **Model override support** (e.g., `modelIdOverride`) to better match different proxy/model setups.

### 🧪 Quality & Reliability
- **Expanded unit test coverage** across providers, commands, config, telemetry, and utilities.
- **Lint and stability fixes** to keep the codebase clean and CI-friendly.

---

## [1.3.3] - 2026-02-09

### ✨ Features
- feat/bugfix, add open-vsx support and caching

---

## [1.3.1] - 2026-02-08

### 🐛 Fixed
- **Cache Bypass Fix for LiteLLM**: Requests now send `extra_body.cache["no-cache"] = true` (LiteLLM-compatible).
- Tests updated to validate the new behavior.
- CI coverage expanded on push.

---

## [1.3.0] - 2026-02-08

### ✨ Features
- **⚙️ VS Code 1.109+ Configuration Modernization**: Updated to align with the Language Model provider settings UI introduced in VS Code 1.109+. Keeps the legacy management command for compatibility while moving toward the modern provider configuration flow.
- **🛡️ More Resilient Model Compatibility**: Added **automatic unsupported-parameter stripping + retry** when providers/models reject certain flags, improving out-of-the-box compatibility across a wider range of LiteLLM-backed models.
- **🧰 Better Tooling/Quota Error Handling**: Fixes issues around Copilot tools failing with "Free Tier Quota Exceeded" behavior.

### ⚙️ Improvements
- **🧠 Smarter Caching Controls**: Refinements to cache-bypass behavior (`no-cache` headers), including **provider-aware handling** (notably for Claude models). Fixes wording/behavior issues around cache-control/no-cache.
- **📦 Smaller, Faster Packaging**: Production builds are bundled/minified via **esbuild** for a **leaner VSIX**. Includes **web-target output support** for VS Code Web hosts.

### 🧪 Quality
- Expanded unit test coverage (especially around previously sparse areas).
- Lint/format cleanup to keep the codebase consistent.

### 🔧 Developer Notes
- CI now uploads **coverage + test results** (Codecov integration).
- Packaging scripts were updated to match the esbuild-based build pipeline.

---

## [1.2.0] - 2026-01-31

### ✨ Features
- **⚡ Disable Caching Support**: Added a new setting `litellm-connector.disableCaching` (enabled by default). This ensures that requests to the LiteLLM proxy include `no-cache` headers, forcing real-time model responses and bypassing potentially stale provider caches.

### 🏗 Build & CI/CD
- **README Synchronization**: The extension now bundles a marketplace-optimized README while preserving the technical documentation on GitHub.
- **Optimized Releases**: Refactored the release process to follow a "Build Once, Deploy Anywhere" pattern. The VSIX binary is now built during the tag event and reused for the marketplace publish, ensuring the exact same code is distributed across all platforms.

---

## [1.1.2] - 2026-01-30

### 🐛 Fixed
- bugfix: add GitHub Copilot extensions to test config
- Bugfix/iss 8 activation error

---

## [1.1.1] - 2026-01-28

### 🐛 Fixed
- github links in packages.json file so vscode emits correct links

---

## [1.1.0] - 2026-01-28

### 📢 Important Repo Update Notice
With this release, we have also updated the repository URL and cleared git commit history to clear up any potential confusion. The previous repository will be archived for the foreseeable future for transparency and to serve as a data point for references if needed.

There have been a tremendous amount of backend work done with this update to make it easier for issue reporting, building, etc.

### 🐛 Fixes
- Fixed a bug with issues switching between `chat/completion` and `/response` endpoints. Previously if you were using an endpoint that used one or other other; switching would often result in failure. This should be resolve with this update now.
- Fixed a bug with switching models during a chat interaction with tool calls. Occasionally it was observed that tool calls would not transfer / update appropriately when switching models.
- Added loop prevention logic during AI Actions in agentic mode. It was observed, that under some conditions the model would begin looping requesting the same data points over and over again not moving off of that process. We've implemented logic to detect this scenario and attempt to break out of it after the 3rd iteration.

---

[Unreleased]: https://github.com/gethnet/litellm-connector-copilot/compare/rel/v1.6.0...HEAD
[1.6.0]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.6.0
[1.5.0]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.5.0
[1.4.6]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.4.6
[1.4.4]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.4.4
[1.4.2]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.4.2
[1.4.0]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.4.0
[1.3.12]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.3.12
[1.3.10]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.3.10
[1.3.9]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.3.9
[1.3.3]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.3.3
[1.3.1]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.3.1
[1.3.0]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.3.0
[1.2.0]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.2.0
[1.1.2]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.1.2
[1.1.1]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.1.1
[1.1.0]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.1.0
