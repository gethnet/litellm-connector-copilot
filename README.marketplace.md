# 🚀 LiteLLM Connector for GitHub Copilot Chat

[![CI](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/gethnet/litellm-connector-copilot/branch/main/graph/badge.svg)](https://codecov.io/gh/gethnet/litellm-connector-copilot)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gethnet/litellm-connector-copilot?sort=semver)](https://github.com/gethnet/litellm-connector-copilot/releases)
![Open VSX Version](https://img.shields.io/open-vsx/v/GethNet/litellm-connector-copilot)
![Open VSX Downloads](https://img.shields.io/open-vsx/dt/GethNet/litellm-connector-copilot)


Bring **any LiteLLM-supported model** into the Copilot Chat model picker — OpenAI, Anthropic (Claude), Google, Mistral, local Llama, and more.

If LiteLLM can talk to it, **Copilot can use it**.

---

## ⭐️ Support the project

If you find this useful, please:

- **Star on GitHub**: https://github.com/gethnet/litellm-connector-copilot
- **Leave a rating/review** on the **VS Code Marketplace**: https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot
- **Rate on Open VSX**: https://open-vsx.org/extension/GethNet/litellm-connector-copilot

Want to support development?

- **Ko-fi**: https://ko-fi.com/amwdrizz
- **Buy Me a Coffee**: https://buymeacoffee.com/amwdrizz

---

## 🚨 Troubleshooting: Connection Issues 🚨

If the extension fails to connect or models don't show up:

1. **Run setup**: Open **`LiteLLM: Manage Configuration`** from the Command Palette (`Ctrl+Shift+P`) and verify your provider group has a Base URL and API key.
2. **Reload models**: Run **`LiteLLM: Reload Models`** to trigger a fresh discovery request.
3. **Reset**: If things are totally stuck, run **`LiteLLM: Reset All Configuration`** to clear all state, then re-add your backends.
4. **Note**: Reinstalling won't help — configuration is stored securely inside VS Code. Use the Reset command instead.

> **Upgrading from 2.0.x?** The old `litellm-connector.baseUrl` / `backends` workspace settings are **gone** in 2.1.0. A migration notification will guide you on first launch. See the [full README](https://github.com/gethnet/litellm-connector-copilot#readme) for details.

---

## ✅ Requirements

- �️ **VS Code 1.120+** (required)
- �🔑 **GitHub Copilot** subscription (Free plan works)
- 🌐 A **LiteLLM proxy URL** and **API key**

---

## ⚡ Quick Start (60 seconds)

1. Install **GitHub Copilot Chat**
2. Install **LiteLLM Connector for Copilot**
3. Open Command Palette (`Cmd/Ctrl+Shift+P`)
4. Run **LiteLLM: Manage Configuration**
5. Add one or more provider groups with:
   - **Name** (used as the picker group label)
   - **Base URL** (e.g. `http://localhost:4000`)
   - **API Key** (required)
6. Open Copilot Chat → pick a model under your provider group label → chat

> **Configuration**: All connection details are managed through VS Code's **Language Models provider-group** UI. No workspace settings required.

> **Multi-Backend**: Configure multiple provider groups to aggregate models from several proxies. Models are namespaced by backend so provider identity is always clear in the picker.

> **Git commit generation**: Set `litellm-connector.commitModelIdOverride` in VS Code Settings to enable the SCM toolbar sparkle button.

---

## ✨ What you get

- 🌍 **Hundreds of models** via your LiteLLM proxy
- ⛓️ **Multi-backend aggregation** from multiple proxy instances
- 🌊 **Real-time streaming** responses
- 🛠️ **Tool / function calling** support
- 👁️ **Vision models** supported (image and PDF input)
- 🧠 **Unified Chat Provider** — text, thinking, data, and tool-call response parts via VS Code 1.120 APIs
- 🧠 **Smart parameter handling** for model quirks (strips unsupported params automatically)
- 🔁 **Automatic retry** when a model rejects unsupported flags
- 📊 **Token tracking & usage** monitoring with input/output budgets
- ✍️ **Git commit generation** from staged changes (set `commitModelIdOverride` to enable)
- 🧼 **Smart Sanitization** automatically strips Markdown code blocks from generated commit messages
- ⏱️ **Inactivity watchdog** to prevent stuck streams
- 🚫🧠 **Cache bypass controls** (`no-cache` headers) with provider-aware behavior
- 🔐 **Secure credential storage** via VS Code's encrypted provider-group configuration
- ⌨️ **Optional inline completions** via VS Code's stable inline completion API

---

## 🆕 What's New in 2.1.0

> **⚠️ Breaking change:** `litellm-connector.baseUrl` / `backends` workspace settings are removed. A migration notification guides you on first launch. See Troubleshooting above if things go sideways.

- 🏗️ **VS Code-Native Configuration** – All backend details now live in VS Code's Language Models provider-group UI. No workspace settings needed.
- 🔄 **Automatic Legacy Migration** – Detects old settings on first launch and guides you through re-entering them in the new format.
- 🔒 **Per-Group Isolation** – Each backend group has fully isolated discovery state.
- 🧩 **Model Override Toggle** – New `enableModelOverrides` setting to disable all override rules when proxy capabilities are accurate.
- 🖼️ **Image & PDF Token Estimation** – Token budget now correctly accounts for image and PDF parts.
- 🛡️ **Discovery Backoff** – Exponential backoff prevents hammering a down proxy.
- 🧼 **Tool Name Sanitization** – Auto-sanitizes tool names for Bedrock-compatible providers.
- 🔧 **Tool Call ID Normalization** – Normalizes IDs for strict providers (GPT-5 / o-series).
- 📊 **Enriched Token Reporting** – Input, output, and reserved budgets all reported in usage tooltips.

---

## ⚙️ Configuration

**Provider connection** (Base URL + API key) is configured through VS Code's **Language Models provider-group UI**. Run **LiteLLM: Manage Configuration** to open it.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `litellm-connector.commitModelIdOverride` | string | `""` | Model ID for git commit generation. **Required** to enable the SCM toolbar button. |
| `litellm-connector.inactivityTimeout` | number | `60` | Seconds of inactivity before the stream is considered idle. |
| `litellm-connector.disableCaching` | boolean | `true` | Send `no-cache` headers to bypass LiteLLM caching. |
| `litellm-connector.enableResponsesApi` | boolean | `false` | **(Experimental)** Enable the `/responses` endpoint integration. |
| `litellm-connector.disableQuotaToolRedaction` | boolean | `false` | Disable automatic tool removal when a quota error is detected. |
| `litellm-connector.enableModelOverrides` | boolean | `true` | Master toggle for model override rules. Set `false` to use only proxy-reported capabilities. |
| `litellm-connector.modelOverrides` | array | `[]` | Regex-based override rules for model reasoning capabilities. |
| `litellm-connector.modelCapabilitiesOverrides` | object | `{}` | Override `toolCalling` / `imageInput` capabilities reported to VS Code. |
| `litellm-connector.inlineCompletions.enabled` | boolean | `false` | Enable inline completions. **(Deprecated: will be removed)** |
| `litellm-connector.sendDefaultParameters` | boolean | `false` | **(Temporary)** Send default temperature/penalty params. Recommended: `false`. |

---

## ⌨️ Commands

- **LiteLLM: Manage Configuration**: Open VS Code's Language Models provider-group UI to add/edit backends.
- **LiteLLM: Reload Models**: Manually trigger a fresh model discovery request.
- **LiteLLM: Select Commit Message Model**: Set `commitModelIdOverride` to choose the commit generation model.
- **LiteLLM: Show Available Models**: See all models currently discovered from your configured backends.
- **LiteLLM: Reset All Configuration**: ⚠️ Clear all stored provider groups, URLs, and API keys.

---

## 🐛 Bug reports & feature requests

Please use GitHub Issues: https://github.com/gethnet/litellm-connector-copilot/issues

Including VS Code version, extension version, model id, and LiteLLM proxy details/logs (if possible) helps reproduce issues quickly.

---

## 🧩 Notes

- This extension is a **provider** for the official Copilot Chat experience.
- It won't function without the **GitHub Copilot Chat** extension installed.

---

## 🆘 Support

- Issues & feedback: https://github.com/gethnet/litellm-connector-copilot/issues
- License: Apache-2.0
