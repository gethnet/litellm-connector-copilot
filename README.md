# 🚀 LiteLLM Connector for Copilot

[![CI](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/gethnet/litellm-connector-copilot/branch/main/graph/badge.svg)](https://codecov.io/gh/gethnet/litellm-connector-copilot)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gethnet/litellm-connector-copilot?sort=semver)](https://github.com/gethnet/litellm-connector-copilot/releases)
![Open VSX Version](https://img.shields.io/open-vsx/v/GethNet/litellm-connector-copilot)
![Open VSX Downloads](https://img.shields.io/open-vsx/dt/GethNet/litellm-connector-copilot)

[![License](https://img.shields.io/github/license/gethnet/litellm-connector-copilot)](LICENSE)

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

## 🛠️ Getting Started (It's Easier Than You Think!)

### Prerequisites

- ✅ **VS Code 1.120+** (required)
- ✅ **GitHub Copilot Individual** subscription (Free or Paid Individual plans work).
  - ⚠️ **Important**: GitHub Copilot Business (Organization) and Enterprise plans are **not currently supported** due to VS Code API limitations. For technical details, see the [VS Code Language Model API documentation](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) and the list of [supported individual plans](https://docs.github.com/en/copilot/concepts/billing/individual-plans).
- 🌐 A **LiteLLM proxy** running somewhere (locally or in the cloud)
- 🔑 Your **Base URL** and **API Key**

> **New to LiteLLM?** Check out [their documentation](https://docs.litellm.ai) to learn how to set up a proxy that can route to any model provider.

### Installation & Setup (60 seconds)

1. **Install** the "LiteLLM Connector for Copilot" extension from the VS Code Marketplace
2. **Open** Command Palette (`Cmd/Ctrl+Shift+P`)
3. **Run** **LiteLLM: Manage Configuration**
4. **Add** one or more backends (name, Base URL, and API key)
5. **Open** Copilot Chat and pick a model from your configured backend/provider group label (for example, `Cloud`, `Local`, `CoolProvider`)
6. **Start chatting!** 🎉

> **Configuration path**: This extension uses VS Code's **Language Models provider-group** flow (VS Code 1.120+) for full model-picker/category behavior. All backend connection details are configured through VS Code's native Language Models settings — no workspace settings required.

> **Multi-Backend Power**: Configure multiple LiteLLM provider groups (for example local + cloud + internal). Models are namespaced and grouped by backend so it is clear which provider each model comes from.

> **Provider grouping remains intact**: each backend name is preserved as its provider/group label, so models stay clearly identifiable in the Language Models view and picker.

> **⚠️ Upgrading from 2.0.x or earlier?** See the [Upgrade Guide](#-upgrading-from-20x-or-earlier) below — configuration has fundamentally changed.

That's it! Your models from the LiteLLM proxy will automatically appear in the model picker.

---

## 💡 What Makes This Special?

This isn't just another AI connector—it's built with care and designed for real-world use:

### 🌍 **Any Model, Any Provider**
Access hundreds of models through your LiteLLM proxy: GPT-4, Claude 3.5, Gemini Pro, Llama 3, DeepSeek, local models, and custom fine-tunes. All in one place.

### ⛓️ **Multi-Backend Aggregation**
Connect to multiple LiteLLM instances at once. Mix and match local, cloud, and team proxies seamlessly. Models from different backends are clearly labeled and ready for use.

### 🌊 **Smooth Streaming Experience**
Real-time, streaming responses just like native Copilot models. No waiting for complete responses—watch as the AI thinks and types.

### 🛠️ **Full Tool Calling Support**
Models can use tools and functions to interact with your workspace. Perfect for code analysis, git operations, and complex workflows.

### 👁️ **Vision Capabilities**
Use image-capable models to analyze screenshots, diagrams, and code directly in chat. Upload images and get insights.

### 🧠 **Rich Response Parts**
The chat provider emits structured response parts to VS Code — text, thinking/reasoning, data, and tool-call parts — using the VS Code 1.120 Language Model APIs. Reasoning models that produce thinking output render correctly in the chat UI.

### 🧠 **Smart, Automatic Compatibility**
The extension automatically handles provider-specific quirks:
- Strips unsupported parameters (like `temperature` for O1 models)
- Retries with cleaned payloads when models reject flags
- Normalizes tool call IDs for strict providers
- No manual parameter tuning needed

### 📊 **Token Awareness**
See real-time token usage with context window indicators (e.g., "↑128K in / ↓16K out"). Helps you stay within limits and understand costs.

### ✍️ **Git Commit Generation**
Generate structured, conventional commit messages from your staged changes. Set `litellm-connector.commitModelIdOverride` to the model ID you want to use — the SCM toolbar sparkle icon will appear automatically once it's configured.

### 🧼 **Smart Sanitization**
Automatically strips Markdown code blocks from generated commit messages for a clean SCM experience.

### ⏱️ **Reliable Timeout Handling**
Optional inactivity watchdog prevents stuck streams. Configurable timeout keeps your workflow smooth.

### 🚫🧠 **Cache Control**
Send `no-cache` headers to bypass LiteLLM caching when you need fresh responses. Provider-aware behavior ensures compatibility.

### 🔐 **Secure by Design**
Your API keys and URLs are stored safely in VS Code's encrypted `SecretStorage`. No plaintext secrets.

### 🧩 **Model Override System**
Fine-grained control over reasoning capabilities for specific models. The override system lets you customize how models are presented to VS Code:

- **`litellm-connector.modelOverrides`** — Define regex-based rules to control reasoning effort levels, tags, and supported parameters for matching models.
- **`litellm-connector.enableModelOverrides`** — Master toggle (default: `true`). Set to `false` to disable all override rules and rely solely on LiteLLM's `/model/info` auto-discovery. Useful when proxy-reported capabilities are accurate and overrides are no longer needed.

When enabled, user-defined overrides take precedence over bundled defaults. Both are merged with auto-discovered capabilities from the LiteLLM proxy.

### ⌨️ **Optional Inline Completions**
Enable LiteLLM-powered inline completions as an alternative to Copilot's default. Requires `litellm-connector.inlineCompletions.enabled` to be set to `true` and a model configured.

---

## 🎯 Who Is This For?

- **Developers** who want to experiment with different AI models without switching tools
- **Teams** that need cost-effective or specialized models for specific tasks
- **Organizations** running private LLMs behind firewalls for security/compliance
- **AI enthusiasts** who want to test new models as soon as they're released
- **Researchers** comparing model performance on real code
- **Anyone** who's thought "I wish I could use [X model] in Copilot Chat"

---

## 🆕 What's New in 2.1.0?

> **This is a significant release.** The entire configuration system has been rebuilt around VS Code's native Language Models provider-group UI. See [Upgrading from 2.0.x](#-upgrading-from-20x-or-earlier) if you're coming from a previous release.

- 🔄 **Automatic Legacy Config Migration** – On first launch after upgrading, the extension detects old `litellm-connector.baseUrl` / `backends` workspace settings and guides you through migrating to the new provider-group format via an in-editor notification.
- 🏗️ **VS Code-Native Configuration** – All backend connection details (Base URL, API key) are now managed exclusively through VS Code's **Language Models** provider-group UI. No workspace settings needed.
- 🔒 **Per-Group Isolation** – Each configured provider group has fully isolated model discovery state. Multiple backends no longer share or bleed state.
- 🧩 **Model Override Master Toggle** – `litellm-connector.enableModelOverrides` lets you disable all override rules and rely purely on your LiteLLM proxy's `/model/info` responses.
- 🧼 **Tool Name Sanitization for Bedrock** – Tool names are automatically sanitized for Bedrock-compatible providers.
- 🔧 **Tool Call ID Normalization** – Tool call IDs normalized to ≤40 characters for strict providers (GPT-5 / o-series).
- 🖼️ **Image & PDF Token Estimation** – Token budget now accounts for image and PDF data parts (fixes #76).
- 🛡️ **Discovery Backoff** – Repeated discovery failures trigger exponential backoff so a down proxy doesn't hammer VS Code.
- 📊 **Enriched Token Reporting** – Input, output, and reserved output budgets all reported in telemetry and usage tooltips.
- 🧱 **Unified Stream Interpreter** – `/responses` endpoint stream handling consolidated into the shared interpreter used by all providers.

---

## ⚙️ Configuration Options

### Provider Connection (via VS Code Language Models UI)

Base URL and API key are configured through **VS Code's Language Models provider-group UI** — not workspace settings. Open VS Code Settings → Language Models, or run **LiteLLM: Manage Configuration** to add/edit provider groups.

> ❌ `litellm-connector.baseUrl`, `litellm-connector.backends`, and `litellm-connector.apiKey` are **removed** in 2.1.0. See [Upgrading from 2.0.x](#-upgrading-from-20x-or-earlier).

### Workspace Settings

Fine-tune behavior with these settings (accessible via VS Code Settings):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `litellm-connector.commitModelIdOverride` | string | `""` | Model ID for git commit message generation. **Required** to enable the SCM toolbar button. Leave empty to disable. |
| `litellm-connector.inactivityTimeout` | number | `60` | Seconds of inactivity before the connection is considered idle. |
| `litellm-connector.disableCaching` | boolean | `true` | Send `no-cache` headers to bypass LiteLLM caching. |
| `litellm-connector.enableResponsesApi` | boolean | `false` | **(Experimental)** Enable the `/responses` endpoint integration. |
| `litellm-connector.disableQuotaToolRedaction` | boolean | `false` | Disable automatic tool removal when a quota error is detected in chat history. |
| `litellm-connector.enableModelOverrides` | boolean | `true` | Master toggle for the model override system. Set `false` to rely solely on LiteLLM `/model/info` capabilities. |
| `litellm-connector.modelOverrides` | array | `[]` | User-supplied regex-based override rules for model reasoning capabilities. Merged on top of bundled overrides. |
| `litellm-connector.modelCapabilitiesOverrides` | object | `{}` | Override model capabilities (`toolCalling`, `imageInput`) reported to VS Code. |
| `litellm-connector.inlineCompletions.enabled` | boolean | `false` | Enable LiteLLM inline completions. **(Deprecated: will be removed)** |
| `litellm-connector.inlineCompletions.modelId` | string | `""` | **(Deprecated)** Use VS Code's [`inlineChat.defaultModel`](vscode://settings/inlineChat.defaultModel) setting instead. |
| `litellm-connector.sendDefaultParameters` | boolean | `false` | **(Temporary, will be removed)** Send default temperature/penalty parameters if not provided. Recommended: `false`. |

> **Tip**: Most users won't need to touch these—the defaults work great out of the box!

---

## ⌨️ Available Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and try these:

| Command | What It Does |
|---------|--------------|
| **LiteLLM: Manage Configuration** | Opens the VS Code Language Models provider-group management UI to add/edit backends. |
| **LiteLLM: Reload Models** | Manually refresh the model list from your configured backends. |
| **LiteLLM: Reset All Configuration** | ⚠️ Nuke option—clears all stored provider groups, URLs, and API keys. |
| **LiteLLM: Select Commit Message Model** | Set the `commitModelIdOverride` to choose which model generates commit messages. |
| **LiteLLM: Show Available Models** | See all models currently discovered from your backends. |

---

## ⬆️ Upgrading from 2.0.x or Earlier

> **Configuration has fundamentally changed in 2.1.0.** The old `litellm-connector.baseUrl`, `litellm-connector.backends`, and `litellm-connector.apiKey` workspace settings have been **removed**.

**Automatic migration**: On first launch after upgrading, the extension detects your old settings and shows a notification to guide you through migrating them to the new provider-group format.

**Manual migration** (if the notification was dismissed or migration failed):
1. Open the Command Palette → **`LiteLLM: Manage Configuration`**
2. Add a provider group for each of your old backends (name, Base URL, API key)
3. Run **`LiteLLM: Reload Models`** to verify discovery

**If things are broken**: Run **`LiteLLM: Reset All Configuration`** to clear all state, then re-add your backends from scratch.

---

## 🐛 Troubleshooting & FAQ

### "Models aren't showing up after configuration"

1. Verify your provider group is configured in VS Code's Language Models settings (run **`LiteLLM: Manage Configuration`**)
2. Ensure your LiteLLM proxy is running and accessible at the Base URL you entered
3. Wait briefly after config edits; model discovery auto-refreshes after configuration changes
4. Try **`LiteLLM: Reload Models`** to force a refresh
5. If still stuck, use **`LiteLLM: Reset All Configuration`** and re-add your backends

### "Connection fails / timeout errors"

- Check that your LiteLLM proxy is running and the Base URL is correct
- Verify network connectivity (firewall, VPN, proxy settings)
- If using a remote proxy, ensure CORS is configured appropriately
- Check the proxy logs for incoming requests

### "Reinstalling didn't fix the problem"

VS Code stores credentials and provider group configuration in encrypted storage that survives reinstalls. Use **`LiteLLM: Reset All Configuration`** to clear everything, then re-add your backends.

### "I get 'Quota Exceeded' errors"

The extension automatically detects quota errors and can redact tools to recover. If this happens frequently:
- Check your LiteLLM proxy's rate limits
- Consider upgrading your plan or adding more API keys
- The `disableQuotaToolRedaction` setting can control this behavior

### "Tool calls are failing"

Some models have strict tool-call validation. The extension normalizes tool call IDs automatically, but if you encounter issues:
- Verify your LiteLLM proxy supports the model's tool-calling format
- Check proxy logs for rejected requests
- Try a different model variant

---

## 📋 Feedback & Contributions

Bug reports and feature requests are welcome!

- **Issues**: https://github.com/gethnet/litellm-connector-copilot/issues
- **Pull Requests**: Contributions are reviewed and appreciated

---

## 📜 License

Apache-2.0 © [GethNet](https://github.com/gethnet)
