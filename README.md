# 🌊 OpenCode Windsurf Auth Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black?logo=bun)](https://bun.sh)
[![Windsurf](https://img.shields.io/badge/Windsurf-Compatible-blue)](https://codeium.com/windsurf)
[![OpenCode](https://img.shields.io/badge/OpenCode-Plugin-green)](https://github.com/opencode-ai/opencode)

> **Unlock 90+ AI models from Windsurf/Codeium in OpenCode** — Claude 4.5 Sonnet, GPT-5.2, Gemini 3.0, SWE-1.5, and many more!

This plugin exposes Windsurf's local language server as an **OpenAI-compatible REST API**, enabling OpenCode to use Windsurf's premium models without additional API keys or cloud authentication.

## ✨ Features

- 🚀 **90+ Models**: Claude 4.5, GPT-5.2, Gemini 3.0, SWE-1.5, Kimi, Grok, and more
- 🔌 **OpenAI-Compatible**: Drop-in replacement for OpenAI API (`/v1/chat/completions`)
- 🔄 **Auto-Discovery**: Automatically finds Windsurf credentials from running process
- 🛡️ **Auto-Retry**: Handles Windsurf restarts gracefully with automatic reconnection
- 📡 **Streaming**: Full SSE streaming support for real-time responses
- 🎯 **Tool Calling**: Prompt-based tool calling support

## 📋 Requirements

- [Bun](https://bun.sh) runtime (Node.js not supported)
- [Windsurf](https://codeium.com/windsurf) IDE running
- [OpenCode](https://github.com/opencode-ai/opencode) CLI

## 🚀 Quick Start

### One-Line Installation

```bash
curl -fsSL https://raw.githubusercontent.com/gabslocked/opencode-windsurf-auth/main/install.sh | bash
```

### Manual Installation

1. **Clone the repository:**
```bash
git clone https://github.com/gabslocked/opencode-windsurf-auth.git
cd opencode-windsurf-auth
```

2. **Install dependencies:**
```bash
bun install
```

3. **Build the plugin:**
```bash
bun run build
```

4. **Deploy to OpenCode:**
```bash
mkdir -p ~/.config/opencode/node_modules/opencode-windsurf-auth
cp -r dist/* ~/.config/opencode/node_modules/opencode-windsurf-auth/
```

5. **Configure OpenCode** (~/.config/opencode/opencode.json):
```json
{
  "providers": {
    "windsurf": {
      "type": "proxy",
      "proxyUrl": "http://127.0.0.1:42100"
    }
  }
}
```

6. **Restart OpenCode** and start using Windsurf models!

## 🧪 Testing

Run the built-in tests to verify everything works:

```bash
bun test
```

Test specific models:
```bash
# Test Claude 4.5 Sonnet
curl -X POST http://127.0.0.1:42100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-4.5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Test SWE-1.5
curl -X POST http://127.0.0.1:42100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "swe-1.5",
    "messages": [{"role": "user", "content": "Review this code"}]
  }'
```

## 🎯 Supported Models

| Category | Models |
|----------|--------|
| **Claude** | claude-4.5-sonnet, claude-4.5-opus, claude-4.6-opus, claude-3.7-sonnet, claude-3.5-sonnet |
| **GPT** | gpt-5.2, gpt-5.2-codex, gpt-5, gpt-4.5, gpt-4o, gpt-4o-mini |
| **Gemini** | gemini-3.0-pro, gemini-3.0-flash, gemini-2.5-pro, gemini-2.5-flash |
| **SWE** | swe-1.5, swe-1.6 |
| **O-Series** | o3, o3-pro, o4-mini |
| **Other** | kimi-k2, kimi-k2.5, grok-3, grok-code-fast, minimax-m2.1, glm-5 |

### Model Variants

Many models support performance variants:

```bash
# GPT-5.2 with different reasoning budgets
gpt-5.2:low
gpt-5.2:medium        # default
gpt-5.2:high
gpt-5.2:xhigh

# Claude with thinking mode
claude-4.5-sonnet:thinking
claude-4.5-opus:thinking

# Gemini with reasoning budgets
gemini-3.0-flash:minimal
gemini-3.0-flash:low
gemini-3.0-flash:medium
gemini-3.0-flash:high
```

## 🔧 How It Works

```
┌─────────────┐      OpenAI API      ┌──────────────┐
│   OpenCode  │ ◄──────────────────► │  Plugin      │
│   CLI       │    localhost:42100   │  (Bun HTTP)  │
└─────────────┘                      └──────┬───────┘
                                            │
                                            │ gRPC
                                            │
┌─────────────┐                      ┌──────▼───────┐
│  Windsurf   │ ◄──────────────────► │  Language    │
│  IDE        │   local process      │  Server      │
└─────────────┘                      └──────────────┘
```

1. **Discovery**: Plugin scans for running Windsurf process to extract CSRF token and gRPC port
2. **Translation**: Converts OpenAI REST API calls to Windsurf gRPC messages
3. **Streaming**: Returns SSE chunks as they arrive from the language server
4. **Auto-Recovery**: Retries with fresh credentials if Windsurf restarts

## 📁 Project Structure

```
opencode-windsurf-auth/
├── src/
│   ├── plugin.ts              # Main HTTP server & OpenAI API endpoints
│   ├── index.ts               # Package exports
│   └── plugin/
│       ├── auth.ts            # Credential discovery (CSRF, port, API key)
│       ├── grpc-client.ts     # gRPC encoding/decoding + Cascade flow
│       ├── models.ts          # Model name → enum/UID mappings
│       ├── types.ts           # TypeScript types
│       └── discovery.ts       # Dynamic protobuf field discovery
├── dist/                      # Compiled output
├── tests/                     # Unit tests
├── install.sh                 # One-line installer
└── README.md                  # This file
```

## 🛠️ Development

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Run tests
bun test

# Build for production
bun run build

# Watch mode for development
bun run dev
```

## 🐛 Troubleshooting

### "Connection failed: connect ECONNREFUSED"
- Make sure Windsurf is running
- Plugin will auto-retry with fresh credentials

### "StartCascade returned empty cascade_id"
- Windsurf may have restarted - plugin will auto-recover
- Check if your Windsurf subscription is active

### "gRPC error 12: unimplemented"
- Some models may not be available in your region/subscription

### Model not working?
- Check ~/.config/opencode/opencode.json has correct proxy URL
- Verify Windsurf is running: pgrep -f language_server
- Check plugin logs in OpenCode output

## 🔒 Security

- Plugin only connects to **localhost** (127.0.0.1)
- Uses Windsurf's existing authentication (no additional API keys)
- Credentials are read from Windsurf's process, never stored
- All communication stays on your machine

## 📄 License

MIT License — see LICENSE file

## 🙏 Credits

- Original project by [rsvedant/opencode-windsurf-auth](https://github.com/rsvedant/opencode-windsurf-auth)
- Fork maintained by [gabslocked](https://github.com/gabslocked)

- Built for [OpenCode](https://github.com/opencode-ai/opencode)
- Powered by [Windsurf](https://codeium.com/windsurf) / Codeium
- Uses [Bun](https://bun.sh) runtime

---

**Enjoy coding with premium AI models!** 🚀
