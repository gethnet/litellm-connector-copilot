# 🚀 LiteLLM Connector for Copilot

[![CI](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/gethnet/litellm-connector-copilot/branch/main/graph/badge.svg)](https://codecov.io/gh/gethnet/litellm-connector-copilot)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gethnet/litellm-connector-copilot?sort=semver)](https://github.com/gethnet/litellm-connector-copilot/releases)
![Open VSX Version](https://img.shields.io/open-vsx/v/GethNet/litellm-connector-copilot)
![Open VSX Downloads](https://img.shields.io/open-vsx/dt/GethNet/litellm-connector-copilot)

[![License](https://img.shields.io/github/license/gethnet/litellm-connector-copilot)](LICENSE)

## 🆕 What's New in 2.5.4

> Version 2.5.4 enables Anthropic prompt caching for eligible models and reports cache usage in telemetry.

- ⚡ **Anthropic prompt caching** — Eligible Claude models automatically receive a single advancing `cache_control: { type: "ephemeral" }` breakpoint when their model card advertises support for `cache_control`.
- 💰 **Lower multi-turn cost** — Prompt-cache usage is captured from Anthropic's root usage fields, making cache reads and writes visible to token accounting, telemetry, and cost reporting. Real-world validation over 70 Claude Opus 5 turns measured 90.2% cache reads and 76% lower cost.
- ♻️ **Safe cache rejection recovery** — If a provider rejects `cache_control`, the retry removes only prompt-cache controls while preserving unrelated LiteLLM gateway-cache settings. Ineligible models remain unstamped.
- 🖥️ **More reliable coverage runs** — Test coverage now selects an unused X display when running under `xvfb-run`, avoiding stale-display and parallel-session collisions.

See [`CHANGELOG.md`](CHANGELOG.md) for previous release notes.

---

## Welcome! Choose Your Own AI Adventure 🎯

Tired of being limited to a single AI model in Copilot Chat? **Break free.**

The LiteLLM Connector unlocks **hundreds of models** from **any provider**—OpenAI, Anthropic, Google, Mistral, local Llama, custom fine-tunes, you name it—and brings them directly into your VS Code Copilot Chat experience.

> **If LiteLLM can talk to it, Copilot can use it.**

Whether you're a developer who wants to experiment with different models, a team that needs cost-effective options, or an organization running private LLMs behind your firewall—this extension gives you the freedom to choose the right model for the job, without leaving your editor.

---

## ⭐️ Support the Project

If this extension saves you time or helps you work more effectively, please consider:

- **⭐ Star the repo** on GitHub: https://github.com/gethnet/litellm-connector-copilot
- **📝 Leave a review** on the VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot
- **☕ Support development** via [Ko-fi](https://ko-fi.com/amwdrizz) or [Buy Me a Coffee](https://buymeacoffee.com/amwdrizz)

Your support keeps this project alive and improving! ❤️

---

## 🛠️ Getting Started (60 Seconds)

### Prerequisites

- ✅ **VS Code 1.120+** (required)
- 🌐 A **LiteLLM proxy** running somewhere (locally or in the cloud)
- 🔑 Your **Base URL** and **API Key**

> **New to LiteLLM?** Check out [their documentation](https://docs.litellm.ai) to learn how to set up a proxy that can route to any model provider.

> **No Copilot subscription required.** BYOK models work **without signing into a GitHub account or a Copilot plan** — including fully air-gapped scenarios with local models. See [Using BYOK Without Copilot](#-using-byok-without-copilot) for how to replace the Copilot-backed utility models.

### Quick Setup

1. Install the "LiteLLM Connector for Copilot" extension from VS Code Marketplace
2. Open Command Palette (`Cmd/Ctrl+Shift+P`)
3. Run **LiteLLM: Manage Configuration**
4. Add one or more backends (name, Base URL, and API key)
5. Open Copilot Chat and pick a model from your configured provider group
6. **Start chatting!** 🎉

> **Configuration flow**: This extension uses VS Code's **Language Models provider-group** flow (VS Code 1.120+) for full model-picker/category behavior.

> **Multi-Backend Power**: Configure multiple LiteLLM provider groups (local + cloud + internal). Models are namespaced and grouped by backend.

---

## 💡 Why This Connector?

In a marketplace flooded with model providers, here's what sets this one apart:

### 🔌 Direct LiteLLM Integration — No Middleman
This connector talks to your LiteLLM proxy **directly**. No third-party translation layers, no wrapper services — just your proxy and VS Code. The implementation handles message formatting, streaming, tool calls, and token accounting natively, giving you full access to LiteLLM's capabilities without abstraction layers getting in the way.

### 🧩 Native VS Code Integration — Not an Afterthought
Features don't just "work" — they're designed to feel native. Model picker groupings, category tags (lightweight/versatile/powerful), reasoning effort selectors, token usage indicators — all first-class citizens in VS Code's Language Model API. This isn't a bolt-on; it's built on the same APIs Copilot itself uses.

### 🏗️ Maintained by Humans, Not Corporations
Currently a **single-maintainer project**. That means:
- Straightforward communication — no layered support teams
- Decisions made quickly, not by committee
- Direct access to the person who actually builds it

We test thoroughly, but things slip through. If something breaks, you'll find us responsive on GitHub Issues.

### ⛓️ Multi-Backend That Actually Works
Aggregate models from multiple LiteLLM proxies (local, cloud, internal) with proper isolation. Each backend's models stay grouped in the picker — no mixing, no confusion.

### 💭 Full Anthropic Thinking Support
Thinking models emit structured reasoning with proper metadata — signatures, redacted thinking, and display preservation preserved across multi-turn tool-use flows. No workarounds needed.

### 🌊 Smooth Streaming Experience
Real-time streaming responses. Watch as the AI thinks and types — no waiting for complete responses.

### 🛠️ Full Tool Calling Support
Models can use tools to interact with your workspace. Perfect for code analysis, git operations, and complex workflows.

### 👁️ Vision Capabilities
Use image-capable models to analyze screenshots, diagrams, and code directly in chat. Images are correctly serialized for all endpoint types including `/responses`.

### 📊 Token Awareness
See real-time token usage with context window indicators (e.g., "↑128K in / ↓16K out").

### ✍️ Git Commit Generation
Generate structured, conventional commit messages from staged changes. Set `commitModelIdOverride` to enable.

### 🔐 Secure by Design
API keys stored safely in VS Code's encrypted `SecretStorage`. No plaintext secrets.

### 🧩 Model Override System
Fine-tune model metadata for specific models via `litellm-connector.modelOverrides` and `litellm-connector.modelCapabilitiesOverrides`. Model-card overrides are disabled by default. See [Applying a Model Override](#-help-applying-a-model-override) for a complete example.

---

## 🎯 Who Is This For?

- **Developers** who want to experiment with different AI models
- **Teams** that need cost-effective or specialized models
- **Organizations** running private LLMs behind firewalls
- **AI enthusiasts** testing new models as they're released
- **Researchers** comparing model performance on real code

---

## 🚫 Using BYOK Without Copilot

**BYOK models work without signing into a GitHub account or a Copilot plan**, including fully air-gapped scenarios. Your LiteLLM Connector models will appear in the Chat model picker and work for chat and agent workflows with no Copilot subscription required.

A few Copilot-backed features stop working without a login because their defaults point at Copilot models. You can redirect **all** of them to your LiteLLM Connector models so the full chat experience keeps working offline.

> ⚠️ **Keep `chat.byokUtilityModelDefault` set to `GitHub Copilot`.** This setting governs how BYOK models are surfaced. Changing it can prevent your BYOK models from appearing in the picker.

### Settings that take a fully qualified model name

A fully qualified model name is `litellm-connector/<provider-group>/<model>`, matching the identifier shown in the Chat model picker. For example: `litellm-connector/azure_ai/text-embedding-3-small`.

| Setting | What it controls | Example value |
|---------|------------------|---------------|
| `github.copilot.selectedCompletionModel` | Inline completions model | `litellm-connector/<group>/<model>` |
| `github.copilot.chat.workspace.preferredEmbeddingsModel` | Semantic search embeddings | `litellm-connector/<group>/<embedding-model>` |
| `github.copilot.chat.instantApply.shortContextModelName` | Instant Apply short-context model | `litellm-connector/<group>/<model>` |

### Settings that use a model dropdown

These settings present a dropdown of every available model (including your BYOK models). Pick the LiteLLM Connector model you want from the list.

| Setting | What it controls |
|---------|------------------|
| `chat.utilityModel` | Background utility model (chat titles, rename suggestions, etc.) |
| `chat.utilitySmallModel` | Lightweight utility model (commit messages, summaries) |

### Example `settings.json`

```jsonc
{
  // Keep this as "GitHub Copilot" so BYOK models are surfaced correctly.
  "chat.byokUtilityModelDefault": "GitHub Copilot",

  // Redirect Copilot-backed features to LiteLLM Connector models.
  // Use the fully qualified name from the Chat model picker.
  "github.copilot.selectedCompletionModel": "litellm-connector/<group>/<model>",
  "github.copilot.chat.workspace.preferredEmbeddingsModel": "litellm-connector/<group>/<embedding-model>",
  "github.copilot.chat.instantApply.shortContextModelName": "litellm-connector/<group>/<model>",

  // Pick these from the model dropdown in Settings UI.
  "chat.utilityModel": "litellm-connector/<group>/<model>",
  "chat.utilitySmallModel": "litellm-connector/<group>/<small-model>"
}
```

Replace `<group>` with your configured provider group name and `<model>` / `<embedding-model>` / `<small-model>` with the model names from your LiteLLM proxy. After saving, reload the window (`Developer: Reload Window`) for the changes to take effect.

### Copy a fully qualified model name

Run **LiteLLM: Show Available Models** from the Command Palette after configuring a provider and running **LiteLLM: Reload Models**. Select a model to copy its fully qualified ID to the clipboard.

The copied ID is the complete model ID shown by discovery, including the provider-group namespace. Use that value in settings such as `github.copilot.selectedCompletionModel`, `chat.utilityModel`, or `chat.utilitySmallModel`. The picker displays a friendly model name, but copies the complete routable ID.

> **Enterprise note:** For Copilot Business or Enterprise, organization administrators can control BYOK availability through Copilot policy settings. If your admin has disabled BYOK, these models will not appear even after configuration.

---

## ⚙️ Configuration

### Provider Connection (via VS Code Language Models UI)

Base URL and API key are configured through **VS Code's Language Models provider-group UI**. Run **LiteLLM: Manage Configuration** or open Settings → Language Models.

The optional **Inline Completions URL** is a full OpenAI-compatible FIM `/completions` endpoint. If omitted, the connector derives it by appending `/completions` to the configured provider-group URL: `/v1` is preserved when present and is not added when absent. A model-specific `completionsUrl` override takes precedence over the group value. Models without a resolved endpoint remain chat-only for inline suggestions.

### Workspace Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `litellm-connector.commitModelIdOverride` | string | `""` | Model ID for git commit message generation. Accepts the complete `litellm-connector/<group>/<model>` value copied from the model picker; the vendor prefix is normalized automatically. |
| `litellm-connector.inactivityTimeout` | number | `60` | Seconds before connection is considered idle |
| `litellm-connector.disableCaching` | boolean | `false` | When enabled, bypass LiteLLM caching for models that advertise support for the `cache` parameter |
| `litellm-connector.disableQuotaToolRedaction` | boolean | `false` | Disable automatic tool removal on quota errors |
| `litellm-connector.enableModelOverrides` | boolean | `false` | Master toggle for user and bundled model-card overrides |
| `litellm-connector.modelOverrides` | array | `[]` | User-supplied regex-based field overrides; only explicitly defined fields replace LiteLLM data |
| `litellm-connector.modelCapabilitiesOverrides` | object | `{}` | Enable `toolCalling`, `imageInput`, and explicit edit-tool hints for a model |
| `litellm-connector.displayPricingInPicker` | boolean | `true` | Show model pricing in picker details, hovers, and cost metadata; native model-name rows remain price-free |
| `litellm-connector.discoveryTimeoutMs` | number | `5000` | Timeout (ms) for `/model/info` discovery requests |
| `litellm-connector.discoveryCacheTtlMs` | number | `60000` | TTL (ms) for cached discovery responses. Set 0 to disable |
| `litellm-connector.discoveryFireDebounceMs` | number | `250` | Debounce window (ms) for model-change notifications |
| `litellm-connector.discoveryFireMinIntervalMs` | number | `2000` | Min interval (ms) between change notifications |

> **Tip**: Most users won't need to touch these — the defaults work great! Caching bypass and model-card overrides are opt-in.

### Model-picker metadata

The native VS Code model dropdown keeps each row focused on model identity: it does not show pricing inline with the model name. When `displayPricingInPicker` is enabled, prices remain available in native picker hovers and cost metadata, as well as the details of the extension-owned **LiteLLM: Show Available Models** and commit-model pickers. Pricing uses per-million-token values rounded to two decimal places, such as `$1.00`.

The picker shows neutral route information through `infoText`, using the model's reported `provider` when available, then `litellm_provider`, and finally `litellm`. When `/model/info` supplies input or output pricing, the extension emits VS Code's numeric cost multiplier and cost-category metadata without assigning the native inline pricing label.

`warningText` is intentionally conditional. It appears only when a configured model override is active or when LiteLLM reports `blocked: true` for the model. Ordinary models do not receive a warning banner. A blocked model also receives a blocked status icon when supported by the host.

Capability flags such as reasoning and tool support are not represented as status icons. Non-blocked provider logos are not emitted unless a verified local provider icon asset is available. The extension never marks itself as the default model, restricts models to a session type, requires a second authorization flow, or invents promotions.

To supply an edit-tool hint when LiteLLM does not report it, configure it explicitly. The allowed values are `find-replace`, `multi-find-replace`, `apply-patch`, and `code-rewrite`; unknown values are ignored.

```json
{
  "litellm-connector.modelCapabilitiesOverrides": {
    "coder-model": "toolCalling,apply-patch,multi-find-replace"
  }
}
```

Omit edit-tool values to let VS Code choose its default editing strategy. The extension does not infer edit-tool support from model names or providers.

### 🛠️ Help: Applying a Model Override

Use a model override when LiteLLM's `/model/info` response is missing or incorrectly reports model-card fields (reasoning flags, endpoint `mode`, token limits, or `supported_openai_params`). Overrides are disabled by default and must be enabled explicitly.

1. Open **Preferences: Open User Settings (JSON)** or **Preferences: Open Workspace Settings (JSON)**.
2. Set `litellm-connector.enableModelOverrides` to `true`.
3. Add a rule to `litellm-connector.modelOverrides`. Match the raw LiteLLM `model_name` with a regular expression.
4. Run **LiteLLM: Reload Models**.

Only fields included in the matching rule are changed; omitted fields remain exactly as LiteLLM reported them. For reasoning metadata, use LiteLLM's exact snake_case model-card field names.

```json
{
  "litellm-connector.enableModelOverrides": true,
  "litellm-connector.modelOverrides": [
    {
      "match": "^claude-opus-4-8$",
      "supports_none_reasoning_effort": false,
      "notes": "Gateway advertises none effort; model only accepts low/medium/high"
    },
    {
      "match": "^gpt-5\\.3-codex$",
      "mode": "chat",
      "notes": "Gateway advertises responses; route chat via /chat/completions"
    },
    {
      "match": "^grok-4\\.5$",
      "supports_none_reasoning_effort": false,
      "max_output_tokens": 128000,
      "notes": "Equal in/out limits collapse prompt budget; hide unsupported none effort"
    },
    {
      "match": "^gpt-5\\.4$",
      "supportedOpenaiParams": ["temperature", "top_p", "tools", "tool_choice", "stream"],
      "notes": "Full replace of supported_openai_params; list is authoritative"
    }
  ]
}
```

In the first example, only `supports_none_reasoning_effort` is corrected for `claude-opus-4-8`. Other fields stay exactly as LiteLLM reported them. To explicitly disable a field, set it to `false`; to replace a `null` value, define the field in the override.

The second example corrects endpoint routing by setting `mode` to `chat`, `responses`, or `completions`. The third example patches raw LiteLLM token fields (`max_output_tokens`, and optionally `max_input_tokens` / `max_tokens` / `context_window_tokens`) before the connector derives VS Code prompt/output budgets, and also hides unsupported `none` effort.

The fourth example sets `supportedOpenaiParams` to the **complete** desired `supported_openai_params` list (full replace, not a merge). When present, that list drives request parameter filtering and wins over static family denylists such as the built-in `gpt-5` temperature strip. An empty list explicitly reports that no parameters are supported; omit the field entirely to keep LiteLLM's reported list unchanged.

The rule can also define `defaultEffort`, but it does not replace the LiteLLM field-level behavior. Use `supports_low_reasoning_effort`, `supports_medium_reasoning_effort`, `supports_high_reasoning_effort`, `supports_xhigh_reasoning_effort`, or `supports_max_reasoning_effort` explicitly when those levels should be available.

> **Note:** Workspace setting `litellm-connector.forceResponsesEndpoint` still runs **after** model overrides. If it is enabled, an overridden `mode: "chat"` is forced to `responses`.

### ⚡ Advanced / Hidden Settings (JSON-Only)

These settings are **not visible in the Settings UI** — they're for power users who need fine-grained control. Add them to your `settings.json`:

| Setting | Type | Default | Why Use It |
|---------|------|---------|------------|
| `litellm-connector.forceResponsesEndpoint` | boolean | `false` | Forces all models to use the `/responses` endpoint instead of per-model mode selection. Applied after `modelOverrides`, so it still wins over an overridden `mode: "chat"`. Useful when you need consistent reasoning/thinking support across all models, or want to ensure all requests use the newer API for features like summary control. |
| `litellm-connector.allowChatCompletionsFallback` | boolean | `false` | When `forceResponsesEndpoint` is true, this lets the connector fall back to `/chat/completions` if `/responses` fails. Escape hatch for models that don't support `/responses`. |

**To add a hidden setting:**
1. Open `settings.json` (Preferences: Open Settings JSON)
2. Add the setting, e.g.: `"litellm-connector.forceResponsesEndpoint": true`

> These exist because they're either developer-facing, potentially risky, or niche use cases. They don't belong in the visual Settings UI.

---

## ⌨️ Available Commands

| Command | What It Does |
|---------|--------------|
| **LiteLLM: Manage Configuration** | Open Language Models UI to add/edit provider groups |
| **LiteLLM: Reload Models** | Manually refresh the model list |
| **LiteLLM: Show Available Models** | See all discovered models |
| **LiteLLM: Generate Commit Message** | Generate a commit message from staged changes |
| **LiteLLM: Set Log Level** | Change the extension's logging verbosity |

---

## Upgrading from Earlier Versions

> **2.1.0+ changed configuration fundamentally.** The old workspace settings (`litellm-connector.baseUrl`, `litellm-connector.backends`) were replaced with VS Code's native Language Models provider-group UI.

**Automatic migration** runs on first launch after upgrading from pre-2.1.0 versions.

**If things are broken**:
1. Run **`LiteLLM: Manage Configuration`** to open VS Code's Language Models settings
2. Remove the LiteLLM provider groups from VS Code's Language Models UI
3. Re-add your backends fresh
4. Run **`LiteLLM: Reload Models`** to verify

---

## 🐛 Troubleshooting & FAQ

### Models aren't showing up
1. Verify your provider group is configured (run **LiteLLM: Manage Configuration**)
2. Ensure your LiteLLM proxy is running and accessible
3. Run **LiteLLM: Reload Models** to force refresh
4. If stuck: manually remove LiteLLM provider groups via VS Code's Language Models settings, then re-add

### Connection fails / timeout errors
- Check that your LiteLLM proxy is running
- Verify network connectivity (firewall, VPN)
- Check proxy logs for rejected requests

### I get 'Quota Exceeded' errors
The extension automatically detects quota errors and can redact tools to recover. Check your LiteLLM proxy's rate limits.

---

## ✨ Contributors

<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-2-orange.svg?style=flat-square)](#-contributors)
<!-- ALL-CONTRIBUTORS-BADGE:END -->

Thanks to everyone who contributes to LiteLLM Connector for Copilot. See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contribution details and recognition guidance.

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/FPA-DavidTai"><img src="https://avatars.githubusercontent.com/u/60372864?v=4?s=100" width="100px;" alt="David Tai"/><br /><sub><b>David Tai</b></sub></a><br /><a href="https://github.com/gethnet/litellm-connector-copilot/commits?author=FPA-DavidTai" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/amwdrizz"><img src="https://avatars.githubusercontent.com/u/amwdrizz?v=4?s=100" width="100px;" alt="amwdrizz"/><br /><sub><b>amwdrizz</b></sub></a><br /><a href="https://github.com/gethnet/litellm-connector-copilot/commits?author=amwdrizz" title="Code">💻</a> <a href="#ideas-amwdrizz" title="Ideas, Planning, & Feedback">🤔</a> <a href="https://github.com/gethnet/litellm-connector-copilot/commits?author=amwdrizz" title="Documentation">📖</a> <a href="#infra-amwdrizz" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#maintenance-amwdrizz" title="Maintenance">🚧</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 📋 Feedback & Contributions

- **Issues**: https://github.com/gethnet/litellm-connector-copilot/issues
- **Pull Requests**: Contributions welcome! See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for guidelines

We recognize and appreciate **all contributors** to this project. See [CONTRIBUTORS.md](CONTRIBUTORS.md) for the full list.

---

## 📜 License

Apache-2.0 © [GethNet](https://github.com/gethnet)