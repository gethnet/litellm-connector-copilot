# 🚀 LiteLLM Connector for GitHub Copilot Chat

[![CI](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/gethnet/litellm-connector-copilot/branch/main/graph/badge.svg)](https://codecov.io/gh/gethnet/litellm-connector-copilot)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gethnet/litellm-connector-copilot?sort=semver)](https://github.com/gethnet/litellm-connector-copilot/releases)
![Open VSX Version](https://img.shields.io/open-vsx/v/GethNet/litellm-connector-copilot)
![Open VSX Downloads](https://img.shields.io/open-vsx/dt/GethNet/litellm-connector-copilot)

Bring **any LiteLLM-supported model** into the Copilot Chat model picker — OpenAI, Anthropic, Google, Mistral, local Llama, and more. If LiteLLM can talk to it, **Copilot can use it**.

---

## 🆕 What's New in 2.5.10

> Version 2.5.10 restores cache/reasoning token counts on `/responses`, stops edit-tool capability overrides from blanking the model list on VS Code 1.138 Stable, and sizes commit-message diffs against the model's real context window.

- 📦 **Cache and reasoning tokens on `/responses`** — Every model routed via `/responses` previously reported `cached_tokens: 0` and `reasoning_tokens: 0` on every turn, even on healthy prompt-cache hits. The OpenAI Responses API names its usage breakdowns `input_tokens_details` / `output_tokens_details` (plural), but the stream interpreter only read the singular form, so the zero fallback was stamped into usage, costs, and telemetry. All three payload shapes (plural, singular bridge, and Anthropic root-level) are now normalized.
- 🛡️ **Edit-tool overrides no longer blank the model list on Stable 1.138+** — VS Code 1.138 removed the experiment that granted proposed-API access to marketplace extensions; `editTools` capability overrides now require the `chatProvider` proposal and are suppressed (with a one-time warning) when it is not granted, instead of discarding the entire model list for the group. `toolCalling` and `imageInput` overrides are unaffected.
- 📏 **Commit diffs sized against the real context window** — The commit-message generator now budgets the staged diff from the selected VS Code model's reported `maxInputTokens` (previously a stale 128k default), applies a single adaptive 1,000–8,000-token output reserve (`litellm-connector.commitOutputTokenReserve`), and measures the diff with the same heuristic tokenizer used for prompts, so small-context models stop overflowing.

See [`CHANGELOG.md`](CHANGELOG.md) for previous release notes.

---

## ⭐️ Support the Project

- ⭐ **Star on GitHub**: https://github.com/gethnet/litellm-connector-copilot
- 📝 **Leave a review** on the VS Code Marketplace
- ☕ **Support development**: [Ko-fi](https://ko-fi.com/amwdrizz) | [Buy Me a Coffee](https://buymeacoffee.com/amwdrizz)

---

## ⚡ Quick Start (60 Seconds)

1. Install **GitHub Copilot Chat** (if not already installed)
2. Install **LiteLLM Connector for Copilot**
3. Open Command Palette (`Ctrl+Shift+P`)
4. Run **LiteLLM: Manage Configuration**
5. Add a provider group:
   - **Name** (e.g., "Cloud", "Local")
   - **Base URL** (e.g., `http://localhost:4000`)
   - **API Key** (required)
6. Open Copilot Chat → pick a model → start chatting!

---

## ✅ Requirements

- 🖥️ **VS Code 1.125+**
- 🌐 A **LiteLLM proxy URL** and **API key**

> **No Copilot subscription required.** BYOK models work without a GitHub login or Copilot plan — including air-gapped scenarios. See [Using BYOK Without Copilot](#-using-byok-without-copilot) to redirect the Copilot-backed utility models to your LiteLLM models.

---

## ✨ Features & Differentiators

| Feature | Why It Matters |
|---------|----------------|
| 🔌 **Direct LiteLLM Integration** | No third-party wrappers — talks to your proxy directly with native message formatting, streaming, and tool handling |
| 🧩 **Native VS Code Integration** | Model picker groupings, category tags, reasoning effort selectors, token indicators — all first-class in VS Code's Language Model API |
| 👤 **Single-Maintainer Project** | Direct access to the person who builds it. Fast decisions, straightforward communication. We test thoroughly but things slip through — report issues, we respond. |
| 🌍 **Any Model** | Access GPT-4, Claude, Gemini, Llama, DeepSeek, and more |
| ⛓️ **Multi-Backend** | Aggregate from multiple proxies with proper isolation — each backend stays grouped in the picker |
| 💭 **Thinking Support** | Full Anthropic thinking content (signatures, redacted, display metadata) |
| 🌊 **Real-Time Streaming** | Watch responses as they're generated |
| 🛠️ **Tool Calling** | Models can use tools to interact with your workspace |
| 👁️ **Vision** | Image analysis support |
| 📊 **Token Tracking** | Real-time input/output token usage |
| ✍️ **Commit Generation** | Generate conventional commit messages from staged changes |
| 🔐 **Secure** | API keys stored in VS Code's encrypted storage |

---

## 🐛 Troubleshooting

**Models not showing up?**
1. Run **LiteLLM: Manage Configuration** and verify Base URL + API key
2. Run **LiteLLM: Reload Models** to force refresh
3. If stuck: Remove LiteLLM provider groups via **LiteLLM: Manage Configuration** → VS Code's Language Models UI, then re-add
4. On VS Code 1.138+ stable, remove any edit-tool values (`find-replace`, `apply-patch`, …) from `litellm-connector.modelCapabilitiesOverrides` — they require a proposed API and blank the model list. `toolCalling` and `imageInput` are fine.

**"Sign in to use GitHub Copilot" appears while using BYOK?**
A background utility call is being routed to a Copilot model. Set `chat.byokUtilityModelDefault` to `"mainAgent"` — see below.

---

## 🚫 Using BYOK Without Copilot

**BYOK models work without signing into a GitHub account or a Copilot plan**, including fully air-gapped scenarios. Your LiteLLM Connector models appear in the Chat model picker and work for chat and agent workflows with no Copilot subscription required.

A few Copilot-backed features stop working without a login because their defaults point at Copilot models. You can redirect **all** of them to your LiteLLM Connector models so the full chat experience keeps working offline.

> ⚠️ **Set `chat.byokUtilityModelDefault` to `"mainAgent"` when you are not signed in to Copilot.** Since VS Code 1.134 it defaults to `"copilot"`, which routes background utility calls (chat titles, commit messages, summaries) to Copilot models and shows a **"Sign in to use GitHub Copilot"** dialog when no Copilot token is available. `"mainAgent"` reuses your selected LiteLLM chat model. A specific model in `chat.utilityModel` / `chat.utilitySmallModel` always takes precedence. This setting does not affect which models appear in the picker.

### Settings that take a fully qualified model name

A fully qualified model name is `litellm-connector/<provider-group>/<model>`, matching the identifier shown in the Chat model picker.

| Setting | What it controls |
|---------|------------------|
| `github.copilot.selectedCompletionModel` | Inline completions model |
| `github.copilot.chat.workspace.preferredEmbeddingsModel` | Semantic search embeddings |
| `github.copilot.chat.instantApply.shortContextModelName` | Instant Apply short-context model |

### Settings that use a model dropdown

These settings present a dropdown of every available model (including your BYOK models). Pick the LiteLLM Connector model you want from the list.

| Setting | What it controls |
|---------|------------------|
| `chat.utilityModel` | Background utility model (chat titles, rename suggestions) |
| `chat.utilitySmallModel` | Lightweight utility model (commit messages, summaries) |

### Example `settings.json`

```jsonc
{
  // Use your selected LiteLLM chat model for utility calls instead of Copilot.
  // Values: "mainAgent" | "copilot" (default; requires Copilot sign-in) | "none" (error if unset).
  "chat.byokUtilityModelDefault": "mainAgent",

  // Redirect Copilot-backed features to LiteLLM Connector models.
  "github.copilot.selectedCompletionModel": "litellm-connector/<group>/<model>",
  "github.copilot.chat.workspace.preferredEmbeddingsModel": "litellm-connector/<group>/<embedding-model>",
  "github.copilot.chat.instantApply.shortContextModelName": "litellm-connector/<group>/<model>",

  // Pick these from the model dropdown in Settings UI.
  "chat.utilityModel": "litellm-connector/<group>/<model>",
  "chat.utilitySmallModel": "litellm-connector/<group>/<small-model>"
}
```

Replace `<group>` with your provider group name and the model placeholders with models from your LiteLLM proxy. Reload the window (`Developer: Reload Window`) for changes to take effect.

### Copy a fully qualified model name

After configuring a provider, run **LiteLLM: Reload Models**, then run **LiteLLM: Show Available Models**. Select a model to copy its fully qualified ID to the clipboard for use in VS Code BYOK settings.

The picker shows a friendly model name but copies the complete model ID, including the provider-group namespace. Use the copied value for settings such as `github.copilot.selectedCompletionModel`, `chat.utilityModel`, and `chat.utilitySmallModel`.

### What still requires Copilot

Some surfaces have no BYOK routing in VS Code today, regardless of configuration:

| Surface | Status |
|---------|--------|
| Next Edit Suggestions | Copilot models only |
| Execution / search subagents | Copilot models only |
| Agents window subagents | BYOK main model works; BYOK models are not offered for subagents ([vscode#333802](https://github.com/microsoft/vscode/issues/333802)) |
| Copilot's SCM commit-message sparkle | Follows `chat.utilitySmallModel` / `chat.byokUtilityModelDefault`. The connector's own **LiteLLM: Generate Commit Message** command talks to your LiteLLM model directly and never needs Copilot. |

These are VS Code / Copilot Chat limitations, not connector limitations.

> **Enterprise note:** For Copilot Business or Enterprise, organization administrators can control BYOK availability through Copilot policy settings.

---

## ⚙️ Configuration

Base URL + API key are configured through **VS Code's Language Models UI** (run **LiteLLM: Manage Configuration**).

### Standard Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `commitModelIdOverride` | `""` | Model ID for commit message generation. Accepts the complete `litellm-connector/<group>/<model>` value copied from the model picker; the vendor prefix is normalized automatically. |
| `commitOutputTokenReserve` | `0` | Tokens reserved for the generated commit message when sizing the staged diff. `0` = adaptive (`1000 + 400/file + 40/hunk`), clamped to 1000–8000 |
| `commitSystemPromptOverride` | `""` | Override the system prompt used for git commit message generation. Leave empty for the built-in default. |
| `commitMessagePromptOverride` | `""` | Override the commit message style/body prompt. Leave empty for the built-in default. |
| `inactivityTimeout` | `60` | Seconds before stream is considered idle |
| `disableCaching` | `false` | When enabled, bypass LiteLLM caching for models that advertise support for the `cache` parameter |
| `disableQuotaToolRedaction` | `false` | Disable automatic tool removal on quota errors |
| `enableModelOverrides` | `false` | Enable model-card override rules |
| `displayPricingInPicker` | `true` | Show model pricing in picker details, hovers, and cost metadata; native model-name rows remain price-free |
| `discoveryTimeoutMs` | `5000` | Timeout (ms) for model discovery |
| `discoveryCacheTtlMs` | `60000` | Cache TTL (ms), 0 to disable |
| `discoveryFireDebounceMs` | `250` | Debounce (ms) for change notifications |
| `discoveryFireMinIntervalMs` | `2000` | Min interval (ms) between notifications |

> Reasoning model-card overrides are disabled by default. Enable `enableModelOverrides` when LiteLLM reports incorrect or incomplete reasoning metadata. Overrides replace or add only the explicitly named LiteLLM fields; related fields are not inferred.

### 🛠️ Help: Applying a Model Override

Model overrides are disabled by default. To correct incomplete LiteLLM `/model/info` metadata:

1. Open **Preferences: Open User Settings (JSON)** or **Preferences: Open Workspace Settings (JSON)**.
2. Set `litellm-connector.enableModelOverrides` to `true`.
3. Add a matching rule to `litellm-connector.modelOverrides`.
4. Run **LiteLLM: Reload Models**.

Use the raw LiteLLM `model_name` and exact snake_case model-card fields. Only explicitly defined fields are changed; related fields are not inferred.

```json
{
   "litellm-connector.enableModelOverrides": true,
   "litellm-connector.modelOverrides": [
      {
         "match": "^gpt-4\\.8$",
         "supports_reasoning": true,
         "supports_max_reasoning_effort": true
      }
   ]
}
```

Define each desired effort explicitly, such as `supports_xhigh_reasoning_effort: true`. Setting one effort field does not enable `supports_reasoning` or any other effort field automatically.

### Advanced (JSON-Only)

These aren't in Settings UI — add to `settings.json` if needed:

| Setting | Default | Why Use It |
|---------|---------|------------|
| `forceResponsesEndpoint` | `false` | Force all models to use `/responses` endpoint for consistent reasoning/thinking support |
| `allowChatCompletionsFallback` | `false` | Fall back to `/chat/completions` if `/responses` fails (needs `forceResponsesEndpoint: true`) |

---

## ⌨️ Commands

- **LiteLLM: Manage Configuration** — Add/edit provider groups
- **LiteLLM: Reload Models** — Refresh model list
- **LiteLLM: Show Available Models** — View discovered models and copy a fully qualified ID to the clipboard
- **Generate Commit Message** — Generate a commit message from staged changes (SCM sparkle appears once `commitModelIdOverride` is set)
- **LiteLLM: Set Log Level** — Change logging verbosity
- **LiteLLM: Reset All Configuration** — Remove all provider groups, API keys, and connector settings (asks for confirmation)

---

## 📋 Feedback & Issues

- **GitHub Issues**: https://github.com/gethnet/litellm-connector-copilot/issues

---

## 🧩 Notes

- This extension is a **language model provider** for VS Code Chat
- Works **with or without** GitHub Copilot (BYOK models work without a Copilot subscription)
- VS Code Chat (formerly Copilot Chat) is built into VS Code 1.120+

---

## 📜 License

Apache-2.0 © [GethNet](https://github.com/gethnet)