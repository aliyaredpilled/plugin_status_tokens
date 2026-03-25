# openclaw-context-meter

Automatic context window usage footer for OpenClaw Telegram bots.

After every bot response, sends a small status message showing how much of the model's context window is used:

```
📊 45k / 200k (22%)
```

When compaction is detected (tokens drop significantly), shows the before/after:

```
📊 30k / 200k (15%) — сжат с 150k
```

## Features

- Zero-cost: uses `agent_end` + `message_sent` hooks only, no extra API calls
- No subprocesses: model context windows are hardcoded (no `execSync` OOM risk)
- Smart filtering: skips tool_use turns, only sends footer after final text response
- Debounced: waits 1.5s after last message to avoid footer mid-stream
- Multi-agent: works with multiple agents and Telegram accounts
- Compaction detection: detects token drops and shows before/after stats

## Install

### From npm (recommended)

```bash
cd ~/.openclaw/extensions
npm pack openclaw-context-meter
tar xzf openclaw-context-meter-*.tgz
mv package context-meter
rm openclaw-context-meter-*.tgz
```

### Manual

```bash
mkdir -p ~/.openclaw/extensions/context-meter
cp index.ts openclaw.plugin.json ~/.openclaw/extensions/context-meter/
```

### Enable in config

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["context-meter"],
    "entries": {
      "context-meter": { "enabled": true }
    }
  }
}
```

Restart gateway:

```bash
systemctl --user restart openclaw-gateway
```

## Requirements

- **OpenClaw >= 2026.3.22** (for plugin manifest support and compaction notifications)
- Telegram channel enabled
- **`blockStreaming: true`** in Telegram channel config (required — without it, the `message_sent` hook does not fire and footer delivery becomes unreliable after plugin hot-reloads)

## Supported models (40+)

| Provider | Models | Context Window |
|----------|--------|---------------|
| OpenAI Codex | gpt-5.4 / pro / mini / nano, gpt-5.3-codex | 272k |
| OpenAI | gpt-5.2, gpt-5.1, gpt-5-mini / nano | 400k |
| Anthropic | claude-opus-4-6 | 1M |
| Anthropic | claude-sonnet-4-6 / 4-5, claude-haiku-4-5 | 200k |
| Google | gemini-3-pro / flash | 1M |
| Qwen | qwen3.5-plus, qwen3-coder-plus | 1M |
| Qwen | qwen3-coder-next, coder-model | 262k |
| MiniMax | M2.5 / M2.7 / M2.1 | 200k |
| Z.AI | glm-5, glm-5-turbo, glm-4.7 | 205k |
| xAI | grok | 131k |
| Mistral | mistral-large | 262k |
| Moonshot | kimi-k2.5, kimi-code | 262k |
| Xiaomi | mimo-v2-pro | 262k |

Unknown models default to 200k. To add a model, edit `MODEL_CONTEXT_WINDOWS` in `index.ts`.

## How it works

1. `agent_end` hook fires after each bot response — plugin checks if it was a text response (not tool_use) and finds the Telegram chat ID from the session, then starts a 3s fallback timer
2. `message_sent` hook fires for each Telegram message delivery (requires `blockStreaming: true`) — plugin debounces with 1.5s timer. If `agent_end` was missed (e.g. after plugin hot-reload), `message_sent` creates the pending footer independently
3. After the last message is delivered, reads the session JSONL file tail to get current token count
4. Calculates percentage of model's context window and sends the footer via Telegram Bot API

> **Note:** With `blockStreaming: false` (preview streaming), `message_sent` does not fire. The plugin falls back to `agent_end` only, which may be unreliable after plugin hot-reloads. Always use `blockStreaming: true` for reliable footer delivery.

## v2.0 vs v1.0

v1.0 used `execSync("openclaw models list --json")` to dynamically discover model context windows. This spawned a full OpenClaw process (~2GB RAM) on every plugin load, causing OOM on servers with limited memory.

v2.0 hardcodes model context windows — zero memory overhead, zero subprocesses.

## License

MIT
