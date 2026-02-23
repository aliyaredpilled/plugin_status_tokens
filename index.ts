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

function normalizeModelId(v: string): string {
  return String(v || "").toLowerCase().trim();
}

function stripProviderPrefix(v: string): string {
  const s = normalizeModelId(v);
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function getContextWindow(model: string, cfg: any): number {
  try {
    const modelFull = normalizeModelId(model);
    const modelBase = stripProviderPrefix(model);

    for (const p of Object.values((cfg?.models?.providers ?? {}) as any)) {
      for (const m of (p as any)?.models ?? []) {
        if (!m?.id || !m?.contextWindow) continue;

        const idFull = normalizeModelId(m.id);
        const idBase = stripProviderPrefix(m.id);

        // Support both forms:
        // - runtime: "gpt-5.3-codex"
        // - config : "openai-codex/gpt-5.3-codex"
        if (
          modelFull === idFull ||
          modelBase === idBase ||
          modelFull.includes(idFull) ||
          idFull.includes(modelFull) ||
          modelBase.includes(idBase) ||
          idBase.includes(modelBase)
        ) {
          return m.contextWindow;
        }
      }
    }
  } catch {}

  const low = normalizeModelId(model);
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
          return { totalTokens: e.message.usage.totalTokens, model: e.message.model as string | undefined };
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
      if (!sessionKey || !sessionId) return;

      const usage = getUsage(sessionId);
      if (!usage) return;

      const stateDir = getStateDir();
      const sessionsFile = join(stateDir, "agents/main/sessions/sessions.json");
      if (!existsSync(sessionsFile)) return;

      const sessions: Record<string, any> = JSON.parse(readFileSync(sessionsFile, "utf8"));
      const origin = sessions[sessionKey]?.origin;
      if (origin?.provider !== "telegram") return;

      // origin.to is always "telegram:<chatId>" (works for both direct and group chats)
      // origin.from for groups is "telegram:group:-5170072400" — wrong format for API
      const chatId = (origin.to as string)?.replace("telegram:", "");
      const token  = (api.config as any)?.channels?.telegram?.botToken;
      if (!token) return;

      const modelName = usage.model
        ?? sessions[sessionKey]?.model
        ?? sessions[sessionKey]?.modelOverride
        ?? "claude";

      // Most reliable source: resolved session context chosen by OpenClaw runtime
      const sessionContext = Number(sessions[sessionKey]?.contextTokens);
      const contextWindow = Number.isFinite(sessionContext) && sessionContext > 0
        ? sessionContext
        : getContextWindow(modelName, api.config);

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
