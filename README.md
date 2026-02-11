# 🚀 LiteLLM Connector for GitHub Copilot Chat

[![CI](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/gethnet/litellm-connector-copilot/branch/main/graph/badge.svg)](https://codecov.io/gh/gethnet/litellm-connector-copilot)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gethnet/litellm-connector-copilot?sort=semver)](https://github.com/gethnet/litellm-connector-copilot/releases)
[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/GethNet.litellm-connector-copilot)](https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot)
[![VS Code Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/GethNet.litellm-connector-copilot)](https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot)
[![License](https://img.shields.io/github/license/gethnet/litellm-connector-copilot)](LICENSE)

**Unlock the full power of any LLM inside GitHub Copilot.**

Tired of being locked into a single model? The LiteLLM Connector bridges the gap between VS Code's premier chat interface and the vast universe of models supported by LiteLLM. Whether it's Claude 3.5 Sonnet, GPT-4o, DeepSeek, or your own fine-tuned Llama 3 running locally—if LiteLLM can talk to it, Copilot can now use it.

---

## ⚠️ Important - Prerequisites ⚠️

To use this extension, **YOU MUST** have an active GitHub Copilot plan (the Free plan works). This extension utilizes the VS Code Language Model Chat Provider API, which currently requires a Copilot subscription. For more details, see the [VS Code documentation](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider).

## ✨ Features

* **🌍 Hundreds of Models**: Access any model configured in your LiteLLM proxy (OpenAI, Anthropic, Google, Mistral, etc.) directly from the Copilot model picker.
* **🌊 Real-time Streaming**: Experience smooth, instantaneous responses just like the native models.
* **🛠️ Tool Calling**: Full support for function calling, allowing models to interact with your workspace.
* **👁️ Vision Support**: Use image-capable models to analyze screenshots and diagrams directly in chat.
* **🧠 Smart Parameter Handling**: Automatically handles provider-specific quirks (like stripping `temperature` for O1) so you don't have to.
* **🔁 Automatic Retry on Unsupported Params**: If a model rejects a flag, the connector can strip unsupported parameters and retry.
* **⏱️ Inactivity Watchdog**: Optional timeout to keep long streams from hanging indefinitely.
* **🚫🧠 Cache Bypass Controls**: Send `no-cache` headers to bypass LiteLLM caching (with provider-aware exceptions).
* **🔐 Secure by Design**: Your API keys and URLs are stored safely in VS Code's `SecretStorage`.

## ⚡ Quick Start

1. **Install Prerequisites**: Ensure [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) is installed.
2. **Install Extension**: Install "LiteLLM Connector for Copilot" from the VS Code Marketplace.
3. **Configure Provider**:
   * Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
   * Run the command: `Manage LiteLLM Provider`.
   * Enter your LiteLLM **Base URL** (e.g., `http://localhost:4000`).
   * Enter your **API Key** (if required by your proxy).
4. **Select Model**:
   * Open the Copilot Chat view.
   * Click the model picker and look for the **LiteLLM** section.
5. **Start Chatting!**

---

## 🆕 Recent Highlights

* **🚀 VS Code 1.109+ settings modernization**: configuration now aligns with the Language Model provider settings UI.
* **🧰 Improved error handling**: better behavior around quota/tooling errors.
* **🧱 Tool-call compatibility hardening**: tool call IDs are normalized to comply with OpenAI-compatible limits (prevents hard failures like `tool_calls[].id` too long).
* **🧼 Safer logging**: provider error text is sanitized to avoid dumping echoed prompt/context into logs.
* **📦 Smaller, faster package**: production builds are bundled/minified with **esbuild**.
* **🌐 Web-ready output**: includes a browser-target bundle for VS Code Web hosts.

## 🤝 Attribution & Credits

This project is a fork and evolution of the excellent work started by [Vivswan/litellm-vscode-chat](https://github.com/Vivswan/litellm-vscode-chat). We are grateful for their contribution to the foundation of this extension.

## 🛠️ Development

If you want to contribute or build from source:

### Prerequisites
* [Node.js](https://nodejs.org/) (v18 or higher)
* [npm](https://www.npmjs.com/)

### Setup
1. Clone the repository.
2. Run `npm install` to install dependencies and download the latest VS Code Chat API definitions.
3. Press `F5` to launch the "Extension Development Host" window.

### Common Scripts
* `npm run compile`: Type-check and emit TypeScript output to `out/`.
* `npm run watch`: Build and watch for changes.
* `npm run lint`: Run ESLint (auto-fix where possible).
* `npm run format:check`: Verify formatting without modifying files.
* `npm run test`: Run unit tests.
* `npm run test:coverage`: Run tests and generate coverage reports.
* `npm run bump-version`: Update version in `package.json`.
* `npm run vscode:pack`: Build (esbuild) and package a VSIX.
* `npm run package:marketplace`: Package the extension using `README.marketplace.md` for the VS Code Marketplace while preserving the GitHub README.

## 📚 Learn More

* [LiteLLM Documentation](https://docs.litellm.ai)
* [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)

## Support & Contributions

* **Issues**: Report bugs or request features on [GitHub Issues](https://github.com/gethnet/litellm-connector-copilot/issues).
* **License**: Apache-2.0
