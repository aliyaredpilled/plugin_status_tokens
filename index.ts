import { readFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { join } from "path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// --- Model context window map (hardcoded, no subprocess!) ---

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.4": 272_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.4-nano": 272_000,
  "gpt-5.3-codex": 272_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-6": 200_000,
  "minimax-m2.5": 200_000,
  "minimax-m2.7": 200_000,
  "glm-5": 204_800,
  "gemini": 1_000_000,
};

function getContextWindowForModel(model: string): number {
  const low = String(model || "").toLowerCase().trim();
  if (MODEL_CONTEXT_WINDOWS[low]) return MODEL_CONTEXT_WINDOWS[low];
  for (const [key, val] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (low.includes(key) || key.includes(low)) return val;
  }
  return 200_000;
}

// --- JSONL helpers ---

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

function getUsage(sessionId: string, agentId: string = "main"): { totalTokens: number; model: string } | null {
  try {
    const f = join(getStateDir(), `agents/${agentId}/sessions/${sessionId}.jsonl`);
    if (!existsSync(f)) return null;
    const lines = readTail(f).split("\n").reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e?.message?.role === "assistant" && e.message.usage?.totalTokens) {
          return { totalTokens: e.message.usage.totalTokens, model: e.message.model ?? "" };
        }
      } catch {}
    }
  } catch {}
  return null;
}

// --- Pending footer state ---

type PendingFooter = {
  chatId: string;
  token: string;
  sessionId: string;
  agentId: string;
  timer: ReturnType<typeof setTimeout> | null;
};

const pendingByChat = new Map<string, PendingFooter>();
const lastTokensByChat = new Map<string, number>();

function normalizeChatId(to: string): string {
  return String(to ?? "").replace("telegram:", "");
}

function getBotToken(api: OpenClawPluginApi, agentId: string): string | undefined {
  const tg = (api.config as any)?.channels?.telegram;
  if (!tg) return undefined;
  if (tg.accounts) {
    const bindings = (api.config as any)?.bindings ?? [];
    for (const b of bindings) {
      if (b.agentId === agentId && b.match?.channel === "telegram" && b.match?.accountId) {
        const acct = tg.accounts[b.match.accountId];
        if (acct?.botToken) return acct.botToken;
      }
    }
    if (tg.accounts.default?.botToken) return tg.accounts.default.botToken;
    for (const acct of Object.values(tg.accounts)) {
      if ((acct as any)?.botToken) return (acct as any).botToken;
    }
  }
  return tg.botToken;
}

async function flushFooter(chatId: string) {
  const entry = pendingByChat.get(chatId);
  if (!entry) return;
  pendingByChat.delete(chatId);

  try {
    const usage = getUsage(entry.sessionId, entry.agentId);
    if (!usage) return;

    const contextWindow = getContextWindowForModel(usage.model);
    const pct = Math.round((usage.totalTokens / contextWindow) * 100);
    const kUsed = Math.round(usage.totalTokens / 1000);
    const kMax = Math.round(contextWindow / 1000);

    // Detect compaction: tokens dropped significantly
    const prevTokens = lastTokensByChat.get(chatId);
    lastTokensByChat.set(chatId, usage.totalTokens);

    let footer: string;
    if (prevTokens && prevTokens > usage.totalTokens * 1.3) {
      const kBefore = Math.round(prevTokens / 1000);
      footer = `\u{1F4CA} ${kUsed}k / ${kMax}k (${pct}%) \u{2014} \u{0441}\u{0436}\u{0430}\u{0442} \u{0441} ${kBefore}k`;
    } else {
      footer = `\u{1F4CA} ${kUsed}k / ${kMax}k (${pct}%)`;
    }

    console.log(`[context-meter-lite] footer chat=${chatId}: ${footer}`);

    await fetch(`https://api.telegram.org/bot${entry.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: footer, disable_notification: true }),
    });
  } catch {}
}

// --- Plugin ---

export default function register(api: OpenClawPluginApi) {
  console.log("[context-meter-lite] loaded (no subprocess)");

  // 1) agent_end: mark chat for footer
  api.on("agent_end", async (_evt: any, ctx: any) => {
    try {
      if (!_evt?.success || _evt?.error) return;

      // Skip tool_use turns
      const msgs = _evt?.messages ?? [];
      const lastAssistant = [...msgs].reverse().find((m: any) => m.role === "assistant");
      const lastContent = lastAssistant?.content;
      const hasTextBlock = Array.isArray(lastContent)
        ? lastContent.some((b: any) => b.type === "text" && b.text?.trim())
        : typeof lastContent === "string" && lastContent.trim().length > 0;
      if (!hasTextBlock) return;

      const sessionId = ctx?.sessionId as string | undefined;
      const sessionKey = ctx?.sessionKey as string | undefined;
      const agentId = ctx?.agentId as string || "main";
      if (!sessionId) return;

      // Find telegram chatId from sessions.json
      const stateDir = getStateDir();
      const sessionsFile = join(stateDir, `agents/${agentId}/sessions/sessions.json`);
      if (!existsSync(sessionsFile)) return;

      const sessions: Record<string, any> = JSON.parse(readFileSync(sessionsFile, "utf8"));
      const session = (sessionKey ? sessions[sessionKey] : null)
        ?? Object.values(sessions).find((s: any) => s?.sessionId === sessionId);
      if (!session) return;

      const origin = session.origin;
      if (origin?.provider !== "telegram") return;

      const chatId = normalizeChatId(origin.to as string);
      const token = getBotToken(api, agentId);
      if (!chatId || !token) return;

      // Cancel existing pending
      const existing = pendingByChat.get(chatId);
      if (existing?.timer) clearTimeout(existing.timer);

      pendingByChat.set(chatId, { chatId, token, sessionId, agentId, timer: null });
    } catch {}
  });

  // 2) message_sent: debounce footer after last telegram message
  api.on("message_sent", (evt: any, ctx: any) => {
    try {
      if (ctx?.channelId !== "telegram") return;

      const chatId = normalizeChatId(evt?.to ?? "");
      const entry = pendingByChat.get(chatId);
      if (!entry) return;

      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => flushFooter(chatId), 1500);
    } catch {}
  });
}
