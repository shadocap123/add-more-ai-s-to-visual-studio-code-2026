[README.md](https://github.com/user-attachments/files/34206577/README.md)
# Any AI Provider

Any AI Provider adds models to the built-in VS Code Chat model picker. It supports:

- Any provider with an OpenAI Chat Completions-compatible API, including custom and local endpoints
- Anthropic's Messages API
- Google's Gemini API

This covers many hosted APIs (for example OpenAI, OpenRouter, Groq, DeepSeek, Together, and Fireworks), as well as local servers such as Ollama when configured with its OpenAI-compatible endpoint. Providers that use a different API protocol need an adapter and are not automatically compatible.

## Run from source

1. Install Node.js and the VS Code Extension Development Host.
2. Run `npm install` and `npm run compile` in this folder.
3. Open this folder in VS Code and press `F5`.
4. In the Extension Development Host, open the Command Palette and run **Any AI Provider: Manage Providers**.
5. Add a provider by choosing its API type, entering a name, model ID, API base URL, and (if needed) API key.
6. Open VS Code Chat and select the added model from the model picker.

Use the model ID and API base URL from your provider. For local OpenAI-compatible servers, the API key can be left blank.

API keys are stored in VS Code's encrypted `SecretStorage`; they are not written to settings or provider configuration. Provider names, endpoints, and model IDs are stored in extension global state.
