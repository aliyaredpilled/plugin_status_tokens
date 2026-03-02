import { readFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// --- Model context window map (loaded once at startup) ---

let modelContextMap: Map<string, number> | null = null;

function buildModelContextMap(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const json = execSync("openclaw models list --json", { timeout: 5000 }).toString("utf8");
    const data = JSON.parse(json);
    for (const m of data?.models ?? []) {
      if (m?.key && m?.contextWindow) {
        map.set(String(m.key).toLowerCase(), Number(m.contextWindow));
        const slash = String(m.key).indexOf("/");
        if (slash >= 0) {
          const shortKey = String(m.key).slice(slash + 1).toLowerCase();
          if (!map.has(shortKey)) {
            map.set(shortKey, Number(m.contextWindow));
          }
        }
      }
    }
  } catch {
    map.set("gpt-5.3-codex", 272_000);
    map.set("claude-sonnet-4-6", 200_000);
    map.set("claude-sonnet-4-5", 200_000);
    map.set("minimax-m2.5", 200_000);
  }
  return map;
}

function getContextWindowForModel(model: string): number {
  if (!modelContextMap) modelContextMap = buildModelContextMap();
  const low = String(model || "").toLowerCase().trim();
  if (modelContextMap.has(low)) return modelContextMap.get(low)!;
  for (const [key, val] of modelContextMap) {
    if (low.includes(key) || key.includes(low)) return val;
  }
  if (low.includes("gemini")) return 1_000_000;
  if (low.includes("minimax")) return 200_000;
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

function getUsage(sessionId: string): { totalTokens: number; model: string } | null {
  try {
    const f = join(getStateDir(), `agents/main/sessions/${sessionId}.jsonl`);
    if (!existsSync(f)) return null;
    const lines = readTail(f).split("\n").reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e?.message?.role === "assistant" && e.message.usage?.totalTokens) {
          return {
            totalTokens: e.message.usage.totalTokens,
            model: e.message.model ?? "",
          };
        }
      } catch {}
    }
  } catch {}
  return null;
}

// --- Pending footer: debounce via message_sent ---

type PendingFooter = {
  chatId: string;
  token: string;
  sessionId: string;
  timer: ReturnType<typeof setTimeout> | null;
};

const pendingByChat = new Map<string, PendingFooter>();

function normalizeChatId(to: string): string {
  return String(to ?? "").replace("telegram:", "");
}

async function flushFooter(chatId: string) {
  const entry = pendingByChat.get(chatId);
  if (!entry) return;
  pendingByChat.delete(chatId);

  try {
    const usage = getUsage(entry.sessionId);
    if (!usage) return;

    const contextWindow = getContextWindowForModel(usage.model);
    const pct   = Math.round((usage.totalTokens / contextWindow) * 100);
    const kUsed = Math.round(usage.totalTokens / 1000);
    const kMax  = Math.round(contextWindow / 1000);
    const footer = `📊 ${kUsed}k / ${kMax}k (${pct}%)`;

    console.log(`[context-meter] sending footer for chat=${chatId}: ${footer}`);

    await fetch(`https://api.telegram.org/bot${entry.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: footer, disable_notification: true }),
    });
  } catch {}
}

// --- Plugin ---

export default function register(api: OpenClawPluginApi) {
  modelContextMap = buildModelContextMap();
  console.log("[context-meter] model map loaded, entries=" + modelContextMap.size);

  // 1) agent_end: mark that this chat needs a footer
  api.on("agent_end", async (_evt: any, ctx: any) => {
    try {
      if (_evt?.success === false) return;

      const sessionKey = ctx?.sessionKey as string | undefined;
      const sessionId  = ctx?.sessionId  as string | undefined;
      if (!sessionKey || !sessionId) return;

      const stateDir = getStateDir();
      const sessionsFile = join(stateDir, "agents/main/sessions/sessions.json");
      if (!existsSync(sessionsFile)) return;

      const sessions: Record<string, any> = JSON.parse(readFileSync(sessionsFile, "utf8"));
      const session = sessions[sessionKey]
        ?? Object.values(sessions).find((s: any) => s?.sessionId === sessionId);
      if (!session) return;

      const origin = session.origin;
      if (origin?.provider !== "telegram") return;

      const chatId = normalizeChatId(origin.to as string);
      const token  = (api.config as any)?.channels?.telegram?.botToken;
      if (!chatId || !token) return;

      console.log(`[context-meter] agent_end: pending footer for chat=${chatId}`);

      // Cancel any existing pending footer for this chat
      const existing = pendingByChat.get(chatId);
      if (existing?.timer) clearTimeout(existing.timer);

      // Set pending footer — will be flushed by message_sent debounce
      // Fallback: flush after 5s if no message_sent arrives
      const entry: PendingFooter = {
        chatId,
        token,
        sessionId,
        timer: setTimeout(() => flushFooter(chatId), 5000),
      };
      pendingByChat.set(chatId, entry);
    } catch {}
  });

  // 2) message_sent: debounce — reset timer on each sent message,
  //    so footer goes out 1.5s after the LAST message is delivered
  api.on("message_sent", (evt: any, ctx: any) => {
    try {
      if (ctx?.channelId !== "telegram") return;

      const chatId = normalizeChatId(evt?.to ?? "");
      const entry = pendingByChat.get(chatId);
      if (!entry) return;

      // Reset debounce timer
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => flushFooter(chatId), 1500);
    } catch {}
  });
}
