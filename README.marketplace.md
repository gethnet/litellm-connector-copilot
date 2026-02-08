# 🚀 LiteLLM Connector for GitHub Copilot Chat

[![CI](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/gethnet/litellm-connector-copilot/branch/main/graph/badge.svg)](https://codecov.io/gh/gethnet/litellm-connector-copilot)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gethnet/litellm-connector-copilot?sort=semver)](https://github.com/gethnet/litellm-connector-copilot/releases)
[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/GethNet.litellm-connector-copilot)](https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot)
[![VS Code Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/GethNet.litellm-connector-copilot)](https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot)

Bring **any LiteLLM-supported model** into the Copilot Chat model picker — OpenAI, Anthropic (Claude), Google, Mistral, local Llama, and more.

If LiteLLM can talk to it, **Copilot can use it**.

---

## ✅ Requirements

- 🔑 **GitHub Copilot** subscription (Free plan works)
- 🌐 A **LiteLLM proxy URL** (and an API key if your proxy requires one)

---

## ⚡ Quick Start (60 seconds)

1. Install **GitHub Copilot Chat**
2. Install **LiteLLM Connector for Copilot**
3. Open Command Palette: `Ctrl+Shift+P` / `Cmd+Shift+P`
4. Run: **Manage LiteLLM Provider**
5. Enter:
   - **Base URL** (example: `http://localhost:4000`)
   - **API Key** (optional)
6. Open Copilot Chat → pick a model under **LiteLLM** → chat 🎉

---

## ✨ What you get

- 🌍 **Hundreds of models** via your LiteLLM proxy
- 🌊 **Real-time streaming** responses
- 🛠️ **Tool / function calling** support
- 👁️ **Vision models** supported (where available)
- 🧠 **Smart parameter handling** for model quirks
- 🔁 **Automatic retry** when a model rejects unsupported flags
- ⏱️ **Inactivity watchdog** to prevent stuck streams
- 🚫🧠 **Cache bypass controls** (`no-cache` headers) with provider-aware behavior
- 🔐 **Secure credential storage** using VS Code `SecretStorage`

---

## 🆕 Recent Highlights

- 🚀 **VS Code 1.109+ settings modernization** (aligns with the Language Model provider settings UI)
- 📦 **Smaller, faster package** (bundled/minified production builds)
- 🌐 **Web-ready output** (includes a browser-target bundle for VS Code Web)

---

## ⚙️ Configuration

- `litellm-connector.inactivityTimeout` *(number, default: 60)*
  - Seconds of inactivity before the LiteLLM connection is considered idle.
- `litellm-connector.disableCaching` *(boolean, default: true)*
  - Sends `no-cache: true` and `Cache-Control: no-cache` to bypass LiteLLM caching.

---

## ⌨️ Commands

- **Manage LiteLLM Provider**: Configure Base URL + API Key; refreshes models.

---

## 🧩 Notes

- This extension is a **provider** for the official Copilot Chat experience.
- It won’t function without the **GitHub Copilot Chat** extension installed.

---

## 🆘 Support

- Issues & feedback: https://github.com/gethnet/litellm-connector-copilot/issues
- License: Apache-2.0
