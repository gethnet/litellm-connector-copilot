# Changelog

All notable changes to this project will be documented in this file.


## [1.6.0-dev17] - 2026-04-04

### 🚧 Development snapshot
* Consolidate the current 1.6 pre-release work on dev17.

### 🎊 New Features
* Telemetry / Non-identifable data collection & reporting.
* Multiple Backend / LiteLLM instances supported - Legacy Method.

### 🛠️ Bug Fixes
* �️ Keep commit-message generation failures visible in both local logs and telemetry.
* 🧭 Propagate request IDs through PostHog request telemetry for better event correlation.
* ⚙️ Fixed undefined silent flag which blocked the ability to configure litellm as a new instance.
* 🛠️ Fixed issues with the nuke command leaving stale models behind when resetting the users configuration.
* 🛠️ Stablized telemetry id and re-scoped unhandled exception detection and handling to be properly aligned with best practices.

### 📊 Telemetry & observability
* �️ Add telemetry feature-usage reporting for chat, completions, inline completions, commit generation, and model picker usage.
* 🔔 Capture feature toggle snapshots and toggle-change events from config changes so opt-in behavior is visible in telemetry.
* 🧭 Extend telemetry exception capture with caller context and add tests for the new feature-usage events.

### 🧪 Testing & validation
* ✅ Add regression coverage for commit-provider exception reporting and request ID propagation in telemetry events.

### 🧩 Configuration & commands
* ⚙️ Teach `ConfigManager` to report feature-toggle state after config changes.
* 🚦 Wire telemetry into model-management and reset/check commands so command execution is tracked consistently.
* 📝 Emit a feature-usage snapshot during extension activation after configuration loads.
* ✅ Add coverage for `ConfigManager` feature-toggle reporting and `TelemetryService` feature event helpers.
* 🛠️ Update telemetry and config tests to verify caller metadata and new event payloads.


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

[Unreleased]: https://github.com/gethnet/litellm-connector-copilot/compare/rel/v1.6.0-dev10...HEAD
[1.6.0-dev10]: https://github.com/gethnet/litellm-connector-copilot/releases/tag/rel/v1.6.0-dev10
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
