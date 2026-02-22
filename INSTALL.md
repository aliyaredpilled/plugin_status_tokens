# Installing context-meter

## Quick install (copy-paste)

```bash
mkdir -p ~/.openclaw/extensions/context-meter
curl -sL https://raw.githubusercontent.com/aliyaredpilled/plugin_status_tokens/main/index.ts \
  -o ~/.openclaw/extensions/context-meter/index.ts
curl -sL https://raw.githubusercontent.com/aliyaredpilled/plugin_status_tokens/main/openclaw.plugin.json \
  -o ~/.openclaw/extensions/context-meter/openclaw.plugin.json
```

Then register in `~/.openclaw/openclaw.json`:

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

Then restart:

```bash
openclaw gateway restart
```

---

## Context window sizes by model

The plugin auto-detects context window from your config, with fallbacks:

| Provider | Model | Context window |
|---|---|---|
| Anthropic | claude-sonnet-4-x, claude-opus | 200k |
| Google | gemini-1.5-pro | 2M |
| Google | gemini-2.0-pro, gemini-3.x | 1M |
| OpenAI | gpt-4o, gpt-4-turbo | 128k |
| MiniMax | MiniMax-M2.5 | 200k |

For exact accuracy, add `contextWindow` to your model entry in `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "my-provider": {
        "models": [
          {
            "id": "my-model-id",
            "contextWindow": 1000000
          }
        ]
      }
    }
  }
}
```

---

## How the footer looks

After every AI reply, a silent notification appears:

```
📊 62k / 200k (31%)
```

It appears ~2 seconds after the reply finishes streaming.

---

## Uninstall

Remove from `openclaw.json` plugins section and restart:

```bash
openclaw gateway restart
```
