# LiteLLM Connector for GitHub Copilot Chat

Bring any LiteLLM-supported model (OpenAI, Anthropic, Google, Mistral, local LLaMA, and more) directly into the Copilot Chat model picker. Enjoy streaming responses, tool calling, and vision support with seamless parameter handling.

## Requirements
- GitHub Copilot subscription (Free plan is sufficient)
- LiteLLM proxy URL (with an API key if your proxy requires one)

## Quick Start
1. Install the **GitHub Copilot Chat** extension.
2. Install **LiteLLM Connector for Copilot**.
3. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Manage LiteLLM Provider**.
4. Enter your **Base URL** (e.g., `http://localhost:4000`) and **API Key** (if required).
5. Open Copilot Chat, choose a model from the **LiteLLM** section, and start chatting.

## Key Features
- **Hundreds of models** via your LiteLLM proxy
- **Real-time streaming** responses
- **Tool/function calling** compatibility
- **Vision** capable models (where supported)
- **Smart parameter handling** per model quirks
- **Secure storage** for credentials using VS Code SecretStorage

## Configuration
- `litellm-connector.inactivityTimeout` (number, default: 60)
  - Seconds of inactivity before the LiteLLM connection is considered idle.
- `litellm-connector.disableCaching` (boolean, default: true)
  - Sends `no-cache: true` and `Cache-Control: no-cache` to bypass LiteLLM caching.

## Commands
- **Manage LiteLLM Provider**: Configure Base URL and API Key; refreshes models.

## Support
- Issues & feedback: https://github.com/gethnet/litellm-connector-copilot/issues
- License: Apache-2.0
