# 🚀 LiteLLM Connector for GitHub Copilot Chat

[![CI](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/gethnet/litellm-connector-copilot/branch/main/graph/badge.svg)](https://codecov.io/gh/gethnet/litellm-connector-copilot)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gethnet/litellm-connector-copilot?sort=semver)](https://github.com/gethnet/litellm-connector-copilot/releases)
![Open VSX Version](https://img.shields.io/open-vsx/v/GethNet/litellm-connector-copilot)
![Open VSX Downloads](https://img.shields.io/open-vsx/dt/GethNet/litellm-connector-copilot)

Bring **any LiteLLM-supported model** into the Copilot Chat model picker — OpenAI, Anthropic, Google, Mistral, local Llama, and more. If LiteLLM can talk to it, **Copilot can use it**.

---

## 🆕 What's New in 2.1.8

- 💭 Full Anthropic thinking content support (signatures, redacted thinking, display metadata)
- 🔢 Token accounting fixes — reasoning tokens now flow correctly to telemetry
- 📊 Reasoning effort object format (`{ effort, summary }`) for GPT-5.4+

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

- 🖥️ **VS Code 1.120+**
- 🤖 **GitHub Copilot** (Free Individual plan works)
- 🌐 A **LiteLLM proxy URL** and **API key**

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

---

## ⚙️ Configuration

Base URL + API key are configured through **VS Code's Language Models UI** (run **LiteLLM: Manage Configuration**).

### Standard Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `commitModelIdOverride` | `""` | Model ID for commit message generation |
| `inactivityTimeout` | `60` | Seconds before stream is considered idle |
| `disableCaching` | `true` | Send `no-cache` headers |
| `enableModelOverrides` | `true` | Enable model override rules |

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
- **LiteLLM: Show Available Models** — View discovered models
- **LiteLLM: Generate Commit Message** — Generate commit from staged changes
- **LiteLLM: Set Log Level** — Change logging verbosity

---

## 📋 Feedback & Issues

- **GitHub Issues**: https://github.com/gethnet/litellm-connector-copilot/issues

---

## 🧩 Notes

- This extension is a **provider** for GitHub Copilot Chat
- Requires the **GitHub Copilot Chat** extension

---

## 📜 License

Apache-2.0 © [GethNet](https://github.com/gethnet)