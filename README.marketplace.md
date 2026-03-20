# 🚀 LiteLLM Connector for GitHub Copilot Chat

[![CI](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/gethnet/litellm-connector-copilot/branch/main/graph/badge.svg)](https://codecov.io/gh/gethnet/litellm-connector-copilot)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gethnet/litellm-connector-copilot?sort=semver)](https://github.com/gethnet/litellm-connector-copilot/releases)
[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/GethNet.litellm-connector-copilot)](https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot)
[![VS Code Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/GethNet.litellm-connector-copilot)](https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot)

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

1.  **Manual Setup**: Run **`Manage LiteLLM Provider`** from the Command Palette (`Ctrl+Shift+P`). This often fixes setup "hiccups".
2.  **Verify**: Run **`LiteLLM: Check Connection`** to test your settings.
3.  **Reset**: If things are totally stuck, run **`LiteLLM: Reset All Configuration`**. This is the "nuke" option to clear all state.
4.  **Note**: Reinstalling usually won't help as settings are stored securely in VS Code. Use the Reset command instead.

---

## ✅ Requirements

- 🔑 **GitHub Copilot** subscription (Free plan works)
- 🌐 A **LiteLLM proxy URL** (and an API key if your proxy requires one)

---

## ⚡ Quick Start (60 seconds)

1. Install **GitHub Copilot Chat**
2. Open the Command Palette: `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
3. Run: **`Manage LiteLLM Provider`** and enter your LiteLLM proxy details.

> **Pro-Tip**: This extension supports both standard Chat and advanced V2 Chat (including thinking models and structured usage reporting) automatically based on the models enabled in your LiteLLM proxy.
2. Install **LiteLLM Connector for Copilot**
3. Open Command Palette: `Ctrl+Shift+P` / `Cmd+Shift+P`
4. Run: **Manage LiteLLM Provider**
5. Enter:
   - **Base URL** (example: `http://localhost:4000`)
   - **API Key** (optional)
6. Open Copilot Chat → pick a model under **LiteLLM** → chat

---

## ✨ What you get

- 🌍 **Hundreds of models** via your LiteLLM proxy
- 🌊 **Real-time streaming** responses
- 🛠️ **Tool / function calling** support
- 👁️ **Vision models** supported (where available)
- 🧠 **Smart parameter handling** for model quirks
- 🔁 **Automatic retry** when a model rejects unsupported flags
- 📊 **Token tracking & usage** monitoring for input/output tokens
- ✍️ **Git commit generation** from staged changes in the SCM view
- 🧼 **Smart Sanitization** automatically strips Markdown code blocks from generated commit messages
- 🔍 **Connection diagnostics** to verify proxy configuration
- ⏱️ **Inactivity watchdog** to prevent stuck streams
- 🚫🧠 **Cache bypass controls** (`no-cache` headers) with provider-aware behavior
- 🔐 **Secure credential storage** using VS Code `SecretStorage`
- ⌨️ **Optional inline completions** via VS Code’s stable inline completion API

---

## 🆕 Recent Highlights

- 🧼 **SCM Message Sanitization** (automatically cleans up generated commit messages by stripping triple backticks)
- ✍️ **Git Commit Message Generation** (generate messages from staged changes directly in the SCM view)
- 📊 **Enhanced Token Awareness** (real-time token counting and context window display in model tooltips)
- 🔍 **Connection Diagnostics** (new `Check Connection` command to validate proxy settings)
- 🚀 **VS Code 1.109+ settings modernization** (aligns with the Language Model provider settings UI)
- 🧱 **Tool-call compatibility hardening** (normalizes tool call IDs to OpenAI-compatible limits)
- 🧰 **Stability Improvements** (hardened JSON parsing and stream error recovery)
- 📦 **Smaller, faster package** (bundled/minified production builds)

---

## ⚙️ Configuration

- `litellm-connector.inactivityTimeout` *(number, default: 60)*
  - Seconds of inactivity before the LiteLLM connection is considered idle.
- `litellm-connector.disableCaching` *(boolean, default: true)*
  - Sends `no-cache: true` and `Cache-Control: no-cache` to bypass LiteLLM caching.

---

## ⌨️ Commands

- **Manage LiteLLM Provider**: Configure Base URL + API Key; refreshes models.
- **LiteLLM: Check Connection**: Verify proxy URL and API key configuration.
- **LiteLLM: Select Inline Completion Model**: Choose a model for inline completions.
- **LiteLLM: Select Commit Message Model**: Choose a model for git commit generation.

---

## 🐛 Bug reports & feature requests

Please use GitHub Issues: https://github.com/gethnet/litellm-connector-copilot/issues

Including VS Code version, extension version, model id, and LiteLLM proxy details/logs (if possible) helps reproduce issues quickly.

---

## 🧩 Notes

- This extension is a **provider** for the official Copilot Chat experience.
- It won’t function without the **GitHub Copilot Chat** extension installed.

---

## 🆘 Support

- Issues & feedback: https://github.com/gethnet/litellm-connector-copilot/issues
- License: Apache-2.0
