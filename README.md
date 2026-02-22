# context-meter — OpenClaw Plugin

Automatically sends a context usage footer after every AI reply in Telegram:

```
📊 62k / 200k (31%)
```

## How it works

- Hooks into `agent_end` — fires after every LLM response
- Reads `totalTokens` from the session JSONL file
- Looks up context window size from config (falls back to known defaults)
- Sends a silent Telegram message with usage stats ~2 seconds after the reply

## Supported models

| Model family | Context window |
|---|---|
| Claude | 200k |
| Gemini | 1M |
| MiniMax | 200k (or from config) |
| GPT-4 | 128k |

Custom models: add `contextWindow` to your provider config in `openclaw.json` and it will be picked up automatically.

## Installation

**1. Copy files:**

```bash
mkdir -p ~/.openclaw/extensions/context-meter
cd ~/.openclaw/extensions/context-meter
curl -O https://raw.githubusercontent.com/aliyaredpilled/plugin_status_tokens/main/index.ts
curl -O https://raw.githubusercontent.com/aliyaredpilled/plugin_status_tokens/main/openclaw.plugin.json
```

**2. Register in `openclaw.json`:**

```json
{
  "plugins": {
    "entries": {
      "context-meter": {
        "path": "~/.openclaw/extensions/context-meter"
      }
    }
  }
}
```

**3. Restart:**

```bash
openclaw gateway restart
```

## Requirements

- OpenClaw with Telegram channel configured
- Plugin runs on `agent_end` hook — works with block streaming enabled

## Why a separate message (not inside the reply)?

With block streaming, Telegram receives the reply via `editMessage`. The internal `message:sent` hook doesn't fire for streaming messages (`sessionKeyForInternalHooks = params.mirror?.sessionKey` — `mirror` is not set during streaming), so the `messageId` of the final message is not accessible from plugins. A follow-up `sendMessage` after a 2-second delay is the reliable solution.

## License

MIT
