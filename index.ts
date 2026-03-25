import { readFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { join } from "path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// --- Model context window map (hardcoded, no subprocess!) ---

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI Codex
  "gpt-5.4": 272_000,
  "gpt-5.4-pro": 272_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.4-nano": 272_000,
  "gpt-5.3-codex": 272_000,
  "gpt-5.3-codex-spark": 128_000,
  "gpt-5.2-codex": 272_000,
  // OpenAI direct
  "gpt-5.2": 400_000,
  "gpt-5.2-pro": 400_000,
  "gpt-5.1": 400_000,
  "gpt-5.1-codex": 400_000,
  "gpt-5.1-codex-mini": 400_000,
  "gpt-5.1-codex-max": 400_000,
  "gpt-5-mini": 400_000,
  "gpt-5-nano": 400_000,
  // Anthropic
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
  // Google
  "gemini-3-pro": 1_048_576,
  "gemini-3-flash": 1_048_576,
  "gemini-3-pro-preview": 1_048_576,
  // MiniMax
  "minimax-m2.5": 200_000,
  "minimax-m2.7": 200_000,
  "minimax-m2.1": 200_000,
  // Z.AI / GLM
  "glm-5": 204_800,
  "glm-5-turbo": 204_800,
  "glm-4.7": 204_800,
  // xAI / Grok
  "grok": 131_072,
  // Qwen / ModelStudio
  "qwen3.5-plus": 1_000_000,
  "qwen3-coder-plus": 1_000_000,
  "qwen3-coder-next": 262_144,
  "qwen3-max": 262_144,
  "coder-model": 262_144,
  // Mistral
  "mistral-large": 262_144,
  // Moonshot / Kimi
  "kimi-k2.5": 262_144,
  "kimi-code": 262_144,
  // Xiaomi / MiMo
  "mimo-v2-pro": 262_144,
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
        if (e?.message?.role === "assistant" && e.message.usage) {
          return { totalTokens: e.message.usage.totalTokens ?? 0, model: e.message.model ?? "" };
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
    if (!usage || !usage.totalTokens) return;

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


  // 1) agent_end: mark chat for footer + start fallback timer
  api.on("agent_end", async (_evt: any, ctx: any) => {
    try {
      // Removed success filter — fallback responses also have usage in jsonl

      // Skip tool_use turns
      const msgs = _evt?.messages ?? [];
      const lastAssistant = [...msgs].reverse().find((m: any) => m.role === "assistant");
      const lastContent = lastAssistant?.content;
      const hasTextBlock = Array.isArray(lastContent)
        ? lastContent.some((b: any) => b.type === "text" && b.text?.trim())
        : typeof lastContent === "string" && lastContent.trim().length > 0;

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

      const origin = session.origin;

      const chatId = normalizeChatId(origin.to as string);
      const token = getBotToken(api, agentId);

      // Cancel existing pending
      const existing = pendingByChat.get(chatId);
      if (existing?.timer) clearTimeout(existing.timer);

      // Start fallback timer (3s) for preview streaming mode
      // where message_sent doesn't fire
      const fallbackTimer = setTimeout(() => flushFooter(chatId), 3000);
      pendingByChat.set(chatId, { chatId, token, sessionId, agentId, timer: fallbackTimer });
    } catch {}
  });

  // 2) message_sent: re-debounce footer after last telegram message
  //    (fires with blockStreaming, doesn't fire with preview streaming)
  api.on("message_sent", (evt: any, ctx: any) => {
    try {
      if (ctx?.channelId !== "telegram") return;

      const chatId = normalizeChatId(evt?.to ?? "");
      if (!chatId) return;

      let entry = pendingByChat.get(chatId);
      if (!entry) {
        // agent_end may have been missed (hot-reload) — create pending from message_sent
        const sessionId = ctx?.sessionId as string | undefined;
        const agentId = ctx?.agentId as string || "main";
        const token = getBotToken(api, agentId);
        if (!sessionId || !token) return;
        entry = { chatId, token, sessionId, agentId, timer: null };
        pendingByChat.set(chatId, entry);
      }

      // Reset timer — wait 1.5s after last block message
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => flushFooter(chatId), 1500);
    } catch {}
  });
}
