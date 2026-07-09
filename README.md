# 🚀 LiteLLM Connector for Copilot

[![CI](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/gethnet/litellm-connector-copilot/branch/main/graph/badge.svg)](https://codecov.io/gh/gethnet/litellm-connector-copilot)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gethnet/litellm-connector-copilot?sort=semver)](https://github.com/gethnet/litellm-connector-copilot/releases)
![Open VSX Version](https://img.shields.io/open-vsx/v/GethNet/litellm-connector-copilot)
![Open VSX Downloads](https://img.shields.io/open-vsx/dt/GethNet/litellm-connector-copilot)

[![License](https://img.shields.io/github/license/gethnet/litellm-connector-copilot)](LICENSE)

## 🆕 What's New in 2.1.9

> Version 2.1.9 improves tool-calling compatibility with LiteLLM models that explicitly do not support the `tool_choice` parameter.

- 🛠️ **Capability-aware tool choice** — The connector now omits `tool_choice` when LiteLLM's model metadata does not list it as supported, while preserving the existing default for models without explicit capability metadata.
- ☁️ **Azure GPT-5.6 compatibility** — Tool-enabled requests no longer send the unsupported `tool_choice` field to affected Azure deployments.

## Previous Release: 2.1.8

> Version 2.1.8 delivers full Anthropic thinking content coverage, token accounting correctness fixes, and reasoning effort object format support for GPT-5.4+.

- 💭 **Full Anthropic thinking/thinking content coverage** — Support for `signature`, `redacted_thinking` blocks, and `display` metadata preservation throughout streaming
- 🔢 **Token accounting correctness** — Reasoning tokens now correctly flow through to telemetry (no more zeroing out)
- 📊 **Reasoning effort object format** — Support for `{ effort: string; summary?: string }` enabling GPT-5.4+ and OpenAI Responses API summary control (`"auto" | "concise" | "detailed"`)

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
- ✅ **GitHub Copilot Individual** subscription (Free or Paid Individual plans work)
- 🌐 A **LiteLLM proxy** running somewhere (locally or in the cloud)
- 🔑 Your **Base URL** and **API Key**

> **New to LiteLLM?** Check out [their documentation](https://docs.litellm.ai) to learn how to set up a proxy that can route to any model provider.

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
Fine-tune reasoning capabilities for specific models via `litellm-connector.modelOverrides` and `litellm-connector.modelCapabilitiesOverrides`.

---

## 🎯 Who Is This For?

- **Developers** who want to experiment with different AI models
- **Teams** that need cost-effective or specialized models
- **Organizations** running private LLMs behind firewalls
- **AI enthusiasts** testing new models as they're released
- **Researchers** comparing model performance on real code

---

## ⚙️ Configuration

### Provider Connection (via VS Code Language Models UI)

Base URL and API key are configured through **VS Code's Language Models provider-group UI**. Run **LiteLLM: Manage Configuration** or open Settings → Language Models.

### Workspace Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `litellm-connector.commitModelIdOverride` | string | `""` | Model ID for git commit message generation |
| `litellm-connector.inactivityTimeout` | number | `60` | Seconds before connection is considered idle |
| `litellm-connector.disableCaching` | boolean | `true` | Send `no-cache` headers to bypass LiteLLM caching |
| `litellm-connector.disableQuotaToolRedaction` | boolean | `false` | Disable automatic tool removal on quota errors |
| `litellm-connector.enableModelOverrides` | boolean | `true` | Master toggle for model override system |
| `litellm-connector.modelOverrides` | array | `[]` | User-supplied regex-based override rules |
| `litellm-connector.modelCapabilitiesOverrides` | object | `{}` | Override `toolCalling` / `imageInput` capabilities |
| `litellm-connector.displayPricingInPicker` | boolean | `true` | Show model pricing in the model picker |
| `litellm-connector.discoveryTimeoutMs` | number | `5000` | Timeout (ms) for `/model/info` discovery requests |
| `litellm-connector.discoveryCacheTtlMs` | number | `60000` | TTL (ms) for cached discovery responses. Set 0 to disable |
| `litellm-connector.discoveryFireDebounceMs` | number | `250` | Debounce window (ms) for model-change notifications |
| `litellm-connector.discoveryFireMinIntervalMs` | number | `2000` | Min interval (ms) between change notifications |

> **Tip**: Most users won't need to touch these — the defaults work great!

### ⚡ Advanced / Hidden Settings (JSON-Only)

These settings are **not visible in the Settings UI** — they're for power users who need fine-grained control. Add them to your `settings.json`:

| Setting | Type | Default | Why Use It |
|---------|------|---------|------------|
| `litellm-connector.forceResponsesEndpoint` | boolean | `false` | Forces all models to use the `/responses` endpoint instead of per-model mode selection. Useful when you need consistent reasoning/thinking support across all models, or want to ensure all requests use the newer API for features like summary control. |
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

## 📋 Feedback & Contributions

- **Issues**: https://github.com/gethnet/litellm-connector-copilot/issues
- **Pull Requests**: Contributions welcome!

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for maintainers.

---

## 📜 License

Apache-2.0 © [GethNet](https://github.com/gethnet)