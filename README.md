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

Copy to your OpenClaw extensions directory:

```bash
mkdir -p ~/.openclaw/extensions/context-meter
cp index.ts openclaw.plugin.json ~/.openclaw/extensions/context-meter/
```

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

## Supported models

| Model | Context Window |
|-------|---------------|
| gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano | 272k |
| gpt-5.3-codex | 272k |
| claude-sonnet-4-6 / claude-sonnet-4-5 | 200k |
| claude-haiku-4-5 / claude-opus-4-6 | 200k |
| minimax-m2.5 / minimax-m2.7 | 200k |
| glm-5 | 205k |
| gemini | 1M |

Unknown models default to 200k. To add a model, edit `MODEL_CONTEXT_WINDOWS` in `index.ts`.

## Requirements

- OpenClaw >= 2026.3.13 (for `agent_end` ctx with `sessionId` + `sessionKey`)
- Telegram channel enabled

## How it works

1. `agent_end` hook fires after each bot response — plugin checks if it was a text response (not tool_use) and finds the Telegram chat ID from the session
2. `message_sent` hook fires for each Telegram message delivery — plugin debounces with 1.5s timer
3. After the last message is delivered, reads the session JSONL file tail to get current token count
4. Calculates percentage of model's context window and sends the footer via Telegram Bot API

## v2.0 vs v1.0

v1.0 used `execSync("openclaw models list --json")` to dynamically discover model context windows. This spawned a full OpenClaw process (~2GB RAM) on every plugin load, causing OOM on servers with limited memory.

v2.0 hardcodes model context windows — zero memory overhead, zero subprocesses.

## License

MIT
