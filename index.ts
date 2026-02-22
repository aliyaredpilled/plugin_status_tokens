import { readFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { join } from "path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const CONTEXT_DEFAULTS: Record<string, number> = {
  claude: 200_000,
  gemini: 1_000_000,
  minimax: 200_000,
  "gpt-4": 128_000,
};

function getStateDir() {
  return process.env.OPENCLAW_STATE_DIR ?? join(process.env.HOME ?? "/root", ".openclaw");
}

function readTail(filePath: string, maxBytes = 32_768): string {
  const fd = openSync(filePath, "r");
  const { size } = fstatSync(fd);
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(size - start);
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  return buf.toString("utf8");
}

function getContextWindow(model: string, cfg: any): number {
  try {
    for (const p of Object.values((cfg?.models?.providers ?? {}) as any)) {
      for (const m of (p as any)?.models ?? []) {
        if (m.id && model.includes(m.id) && m.contextWindow) return m.contextWindow;
      }
    }
  } catch {}
  const low = model.toLowerCase();
  for (const [k, v] of Object.entries(CONTEXT_DEFAULTS)) {
    if (low.includes(k)) return v;
  }
  return 200_000;
}

function getUsage(sessionId: string) {
  try {
    const f = join(getStateDir(), `agents/main/sessions/${sessionId}.jsonl`);
    if (!existsSync(f)) return null;
    const lines = readTail(f).split("\n").reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e?.message?.role === "assistant" && e.message.usage?.totalTokens) {
          return { totalTokens: e.message.usage.totalTokens, model: e.message.model ?? "claude" };
        }
      } catch {}
    }
  } catch {}
  return null;
}

export default function register(api: OpenClawPluginApi) {
  api.on("agent_end", async (_evt: any, ctx: any) => {
    try {
      // Skip if the response was interrupted/cancelled by the user
      if (_evt?.success === false) return;

      const sessionKey = ctx?.sessionKey as string | undefined;
      const sessionId  = ctx?.sessionId  as string | undefined;
      api.logger.info(`[context-meter] agent_end sk=${sessionKey?.slice(-20)} sid=${sessionId?.slice(0,8)}`);
      if (!sessionKey || !sessionId) return;

      const usage = getUsage(sessionId);
      if (!usage) return;

      const stateDir = getStateDir();
      const sessionsFile = join(stateDir, "agents/main/sessions/sessions.json");
      if (!existsSync(sessionsFile)) return;

      const sessions: Record<string, any> = JSON.parse(readFileSync(sessionsFile, "utf8"));
      const origin = sessions[sessionKey]?.origin;
      if (!origin?.from?.startsWith("telegram:")) return;

      const chatId = origin.from.replace("telegram:", "");
      const token  = (api.config as any)?.channels?.telegram?.botToken;
      if (!token) return;

      const contextWindow = getContextWindow(usage.model, api.config);
      const pct    = Math.round((usage.totalTokens / contextWindow) * 100);
      const kUsed  = Math.round(usage.totalTokens / 1000);
      const kMax   = Math.round(contextWindow / 1000);
      const footer = `📊 ${kUsed}k / ${kMax}k (${pct}%)`;

      // Small delay so block streaming finishes before we send
      await new Promise(r => setTimeout(r, 2000));

      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: footer, disable_notification: true }),
      });
    } catch {}
  });
}
