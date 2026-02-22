# AGENTS.md — Instructions for AI agents

If a user asks you to install the context-meter plugin, follow these steps:

## Step 1 — Check if already installed

```bash
ls ~/.openclaw/extensions/context-meter/index.ts 2>/dev/null && echo "exists" || echo "not installed"
```

## Step 2 — Download plugin files

```bash
mkdir -p ~/.openclaw/extensions/context-meter

curl -sL https://raw.githubusercontent.com/aliyaredpilled/plugin_status_tokens/main/index.ts \
  -o ~/.openclaw/extensions/context-meter/index.ts

curl -sL https://raw.githubusercontent.com/aliyaredpilled/plugin_status_tokens/main/openclaw.plugin.json \
  -o ~/.openclaw/extensions/context-meter/openclaw.plugin.json
```

## Step 3 — Register in openclaw.json

Read the current config:

```bash
cat ~/.openclaw/openclaw.json
```

Add or merge the plugins section:

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

Use `gateway config.patch` to safely merge without overwriting other settings:

```
gateway(action="config.patch", raw="{\"plugins\":{\"entries\":{\"context-meter\":{\"path\":\"~/.openclaw/extensions/context-meter\"}}}}", note="Installed context-meter plugin")
```

## Step 4 — Restart gateway

```
gateway(action="restart", note="Loading context-meter plugin")
```

## Step 5 — Verify

After restart, check logs:

```bash
grep "context-meter.*loaded" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -3
```

You should see: `context-meter loaded`

## What it does

After every AI reply, users receive a silent Telegram message:

```
📊 62k / 200k (31%)
```

This shows how much of the context window is used. Useful for long sessions.

## Troubleshooting

**Footer doesn't appear:**
- Check logs: `grep "\[context-meter\]" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -10`
- Make sure the gateway restarted after installing

**Wrong context window size:**
- Add `contextWindow` to your model config in `openclaw.json` (see INSTALL.md)

**Works only for Telegram** — the plugin sends via Telegram Bot API directly.
