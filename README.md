# 🚀 LiteLLM Connector for Copilot

[![CI](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gethnet/litellm-connector-copilot/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/gethnet/litellm-connector-copilot/branch/main/graph/badge.svg)](https://codecov.io/gh/gethnet/litellm-connector-copilot)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gethnet/litellm-connector-copilot?sort=semver)](https://github.com/gethnet/litellm-connector-copilot/releases)
[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/GethNet.litellm-connector-copilot)](https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot)
[![VS Code Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/GethNet.litellm-connector-copilot)](https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot)
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

- ✅ **GitHub Copilot Individual** subscription (Free or Paid Individual plans work).
  - ⚠️ **Important**: GitHub Copilot Business (Organization) and Enterprise plans are **not currently supported** due to VS Code API limitations. For technical details, see the [VS Code Language Model API documentation](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) and the list of [supported individual plans](https://docs.github.com/en/copilot/concepts/billing/individual-plans).
- 🌐 A **LiteLLM proxy** running somewhere (locally or in the cloud)
- 🔑 Your **Base URL** and optionally an **API Key**

> **New to LiteLLM?** Check out [their documentation](https://docs.litellm.ai) to learn how to set up a proxy that can route to any model provider.

### Installation & Setup (60 seconds)

1. **Install** the "LiteLLM Connector for Copilot" extension from the VS Code Marketplace
2. **Open** the Command Palette: `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
3. **Run**: `Manage LiteLLM Provider`
4. **Choose** between **Configure Single Backend (Legacy)** for a quick setup or **Manage Multiple Backends** to aggregate models from several LiteLLM proxy instances.

> **Multi-Backend Power**: You can now connect to multiple LiteLLM instances simultaneously (e.g., Local Llama + Cloud GPT-4 + Internal Proxy). Models are automatically namespaced (e.g., `local/llama-3`) to prevent conflicts.

5. **Enter** your LiteLLM proxy details (Base URL and API Key).
6. **Open** Copilot Chat and pick a model from the **LiteLLM** section.
7. **Start chatting!** 🎉

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

### 🧠 **Smart, Automatic Compatibility**
The extension automatically handles provider-specific quirks:
- Strips unsupported parameters (like `temperature` for O1 models)
- Retries with cleaned payloads when models reject flags
- Normalizes tool call IDs for strict providers
- No manual parameter tuning needed

### 📊 **Token Awareness**
See real-time token usage with context window indicators (e.g., "↑128K in / ↓16K out"). Helps you stay within limits and understand costs.

### ✍️ **Git Commit Generation**
Generate structured, conventional commit messages from your staged changes. The extension analyzes your diff and creates clear, professional commit messages.

### 🧼 **Smart Sanitization**
Automatically strips Markdown code blocks from generated commit messages for a clean SCM experience.

### 🔍 **Built-in Diagnostics**
Run `LiteLLM: Check Connection` anytime to verify your proxy configuration. Troubleshooting made easy.

### ⏱️ **Reliable Timeout Handling**
Optional inactivity watchdog prevents stuck streams. Configurable timeout keeps your workflow smooth.

### 🚫🧠 **Cache Control**
Send `no-cache` headers to bypass LiteLLM caching when you need fresh responses. Provider-aware behavior ensures compatibility.

### 🔐 **Secure by Design**
Your API keys and URLs are stored safely in VS Code's encrypted `SecretStorage`. No plaintext secrets.

### ⌨️ **Optional Inline Completions**
Enable LiteLLM-powered inline completions as an alternative to Copilot's default. Great for experimentation.

---

## 🎯 Who Is This For?

- **Developers** who want to experiment with different AI models without switching tools
- **Teams** that need cost-effective or specialized models for specific tasks
- **Organizations** running private LLMs behind firewalls for security/compliance
- **AI enthusiasts** who want to test new models as soon as they're released
- **Researchers** comparing model performance on real code
- **Anyone** who's thought "I wish I could use [X model] in Copilot Chat"

---

## 🆕 What's New?

- 🚀 **V2 Provider (Experimental)** – A new, high-performance internal baseline provider with minimal transforms and full request tracking. **Hot-reloadable**: toggle it in settings without restarting!
- 📊 **Advanced Token Counting** – Smarter budgeting with local estimation, background refinement, and short-lived caching for faster, more accurate context management.
- 🏎️ **Optimized Model Discovery** – Intelligent discovery throttling with in-flight deduplication and TTL caching to prevent excessive proxy lookups.
- 🧼 **SCM Message Sanitization** – Clean commit messages by automatically stripping triple backticks and Markdown artifacts.
- ✍️ **Git Commit Generation** – Generate structured, conventional commits directly from the SCM view using any LiteLLM-supported model.
- 🔍 **Connection Diagnostics** – Use the `LiteLLM: Check Connection` command to instantly validate your proxy and authentication setup.
- 🧱 **Tool-call Hardening** – Improved compatibility for strict providers (like GPT-5/o1) with normalized tool call IDs.

---

## ⚙️ Configuration Options

Fine-tune your experience with these settings (accessible via VS Code Settings):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `litellm-connector.useV2Provider` | boolean | `false` | **(Experimental)** Use the new V2 baseline provider. Switches instantly without requiring a reload. |
| `litellm-connector.inactivityTimeout` | number | `60` | Seconds of inactivity before the connection is considered idle. |
| `litellm-connector.disableCaching` | boolean | `true` | Send `no-cache` headers to bypass LiteLLM caching. |
| `litellm-connector.commitModelIdOverride` | string | `""` | Override the model used for git commit message generation. |
| `litellm-connector.disableQuotaToolRedaction` | boolean | `false` | Disable automatic tool removal when a quota error is detected in chat history. |
| `litellm-connector.modelOverrides` | object | `{}` | Add or override tags (e.g., `inline-completions`) for specific models. |
| `litellm-connector.inlineCompletions.enabled` | boolean | `false` | **(Deprecated)** Enable legacy inline completions. Use VS Code's native settings instead. |

> **Tip**: Most users won't need to touch these—the defaults work great out of the box!

---

## ⌨️ Available Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and try these:

| Command | What It Does |
|---------|--------------|
| **Manage LiteLLM Provider** | Configure your Base URL and API key. Refreshes the model list. |
| **LiteLLM: Check Connection** | Test if your proxy is reachable and credentials are valid. |
| **LiteLLM: Reload Models** | Manually refresh the model list from your proxy. |
| **LiteLLM: Reset All Configuration** | ⚠️ Nuke option—clears all stored URLs and API keys. |
| **LiteLLM: Select Commit Message Model** | Choose which model generates your commit messages. |
| **LiteLLM: Show Available Models** | See all models currently discovered from your proxy. |
| **LiteLLM: Test V2 Provider** | (V2) Run a smoke test on the V2 provider pipeline. |
| **LiteLLM: Set V2 Log Level** | (V2) Adjust logging verbosity for debugging. |
| **LiteLLM: Show V2 Logs** | (V2) View detailed internal provider logs. |

---

## 🐛 Troubleshooting & FAQ

### "Models aren't showing up after configuration"

1. Run **`LiteLLM: Check Connection`** to verify your Base URL and API key
2. Ensure your LiteLLM proxy is running and accessible
3. Try **`LiteLLM: Reload Models`** to force a refresh
4. If still stuck, use **`LiteLLM: Reset All Configuration`** and start fresh

### "Connection fails / timeout errors"

- Check that your LiteLLM proxy is running and the Base URL is correct
- Verify network connectivity (firewall, VPN, proxy settings)
- If using a remote proxy, ensure CORS is configured appropriately
- Check the proxy logs for incoming requests

### "Reinstalling didn't fix the problem"

VS Code stores credentials in encrypted `SecretStorage`. Reinstalling doesn't clear this. Use **`LiteLLM: Reset All Configuration`** instead.

### "I get 'Quota Exceeded' errors"

The extension automatically detects quota errors and can redact tools to recover. If this happens frequently:
- Check your LiteLLM proxy's rate limits
- Consider upgrading your plan or adding more API keys
- The `disableQuotaToolRedaction` setting can control this behavior

### "Tool calls are failing"

- Ensure your model supports function calling
- The extension normalizes tool call IDs for compatibility, but some very strict providers may still reject certain payloads
- Check the Output panel → "LiteLLM Connector" channel for detailed logs

### "Can I use this without GitHub Copilot?"

No—this extension is a **provider** for the official **GitHub Copilot Chat** extension. You need an active Copilot subscription (Free plan works) and the Copilot Chat extension installed.

---

## 🔧 Advanced Usage

### Using with a Local LiteLLM Proxy

```bash
# Start LiteLLM locally (example with OpenAI)
export OPENAI_API_KEY=your-key
litellm --model gpt-4o --port 4000
```

Then configure the extension with Base URL: `http://localhost:4000`

### Using with Multiple Providers

LiteLLM can route to multiple backends. Configure your `config.yaml` or environment to include multiple model providers, and they'll all appear in the Copilot model picker.

### Enabling Inline Completions

1. Set `litellm-connector.inlineCompletions.enabled` to `true` (though this is being deprecated in favor of VS Code's native inline chat model setting)
2. Run `LiteLLM: Select Inline Completion Model` to choose your model
3. Start typing—completions will appear automatically

> **Note**: The inline completions feature is optional and disabled by default. The primary use case is Copilot Chat.

---

## 🧪 Testing & Quality

This extension maintains **85%+ test coverage** with a comprehensive suite covering:
- Provider orchestration and model discovery
- Streaming and tool call handling
- Parameter filtering and error recovery
- Configuration and secret management
- Token budgeting and message trimming

Run tests locally:
```bash
npm install
npm run test:coverage
```

---

## 🛠️ Development & Contributing

Interested in contributing? We'd love your help!

### Prerequisites
- Node.js 18+
- npm
- VS Code (for debugging)

### Setup
```bash
git clone https://github.com/gethnet/litellm-connector-copilot.git
cd litellm-connector-copilot
npm install
```

Press `F5` in VS Code to launch an Extension Development Host window for testing.

### Common Commands
```bash
npm run compile        # Type-check and build
npm run watch          # Build and watch for changes
npm run lint           # Run ESLint (auto-fix where possible)
npm run format         # Format with Prettier
npm run test           # Run unit tests
npm run test:coverage  # Run tests with coverage report
npm run vscode:pack    # Build and package a VSIX
```

### Code Standards

This project follows strict engineering standards:
- **TDD-first**: Write tests before implementation
- **KISS & DRY**: Keep it simple, avoid duplication
- **Type safety**: No `any` types—strict TypeScript throughout
- **Modular architecture**: Small, focused files with clear responsibilities
- **Comprehensive documentation**: Explain the "why" behind complex logic

See [AGENTS.md](./AGENTS.md) for the full contribution guidelines.

### Reporting Issues

Found a bug or have a feature request? Please [open an issue](https://github.com/gethnet/litellm-connector-copilot/issues) with:

- VS Code version
- Extension version
- Model ID you're using
- LiteLLM proxy version and configuration
- Steps to reproduce
- Relevant logs from the "LiteLLM Connector" output channel

---

## 📚 Learn More

- [LiteLLM Documentation](https://docs.litellm.ai) – How to set up and configure your proxy
- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) – The underlying extension API
- [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) – The official Copilot Chat extension

---

## 🙏 Acknowledgments

This project builds on the excellent work started by [Vivswan/litellm-vscode-chat](https://github.com/Vivswan/litellm-vscode-chat). We're grateful for their pioneering work in connecting LiteLLM to VS Code.

---

## 📄 License

Apache-2.0. See [LICENSE](./LICENSE) for details.

---

## 💬 Get Help & Connect

- **Issues**: https://github.com/gethnet/litellm-connector-copilot/issues
- **Discussions**: Join the conversation on GitHub Discussions
- **Changelog**: See [CHANGELOG.md](./CHANGELOG.md) for version history

---

## 📊 PostHog Error Tracking / Source Maps

This repository supports PostHog exception capture and source map upload for error tracking.

Required environment variables for source map upload:

- `POSTHOG_HOST`
- `POSTHOG_PROJECT_API_KEY`
- `POSTHOG_PERSONAL_API_KEY`
- `POSTHOG_RELEASE` (optional, defaults to `npm_package_version`)
- `POSTHOG_BUILD_DIR` (optional, defaults to `dist`)

Build and upload source maps:

```bash
npm run posthog:sourcemaps
```

---

**Ready to unlock the full potential of AI in your editor?** Install the extension, connect to your LiteLLM proxy, and start exploring the vast world of language models—all without leaving VS Code. 🚀
