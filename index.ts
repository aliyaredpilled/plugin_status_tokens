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
        // Index by full key (e.g. "openai-codex/gpt-5.3-codex")
        map.set(String(m.key).toLowerCase(), Number(m.contextWindow));
        // Also index by short name after "/" (e.g. "gpt-5.3-codex")
        const slash = String(m.key).indexOf("/");
        if (slash >= 0) {
          map.set(String(m.key).slice(slash + 1).toLowerCase(), Number(m.contextWindow));
        }
      }
    }
  } catch {
    // If CLI fails, fall back to sensible defaults
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
  // Exact match
  if (modelContextMap.has(low)) return modelContextMap.get(low)!;
  // Substring match (handles "MiniMax-M2.5" vs "minimax-m2.5" etc.)
  for (const [key, val] of modelContextMap) {
    if (low.includes(key) || key.includes(low)) return val;
  }
  // Generic fallbacks
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
          // model here is always the actual model used for this run
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

// --- Plugin ---

export default function register(api: OpenClawPluginApi) {
  // Pre-build map at startup so first message has no delay
  modelContextMap = buildModelContextMap();
  console.log("[context-meter] model map loaded, entries=" + modelContextMap.size);

  api.on("agent_end", async (_evt: any, ctx: any) => {
    try {
      if (_evt?.success === false) return;

      const sessionKey = ctx?.sessionKey as string | undefined;
      const sessionId  = ctx?.sessionId  as string | undefined;
      if (!sessionKey || !sessionId) return;

      // Get usage from JSONL — this has the REAL model that ran (not sessions.json which
      // may have been updated mid-run by a /models command)
      const usage = getUsage(sessionId);
      if (!usage) return;

      // Resolve context window from actual run model
      const contextWindow = getContextWindowForModel(usage.model);

      console.log(`[context-meter] sessionId=${sessionId} model=${usage.model} contextWindow=${contextWindow}`);

      // Get chat destination from sessions.json
      const stateDir = getStateDir();
      const sessionsFile = join(stateDir, "agents/main/sessions/sessions.json");
      if (!existsSync(sessionsFile)) return;

      const sessions: Record<string, any> = JSON.parse(readFileSync(sessionsFile, "utf8"));
      const session = sessions[sessionKey]
        ?? Object.values(sessions).find((s: any) => s?.sessionId === sessionId);
      if (!session) return;

      const origin = session.origin;
      if (origin?.provider !== "telegram") return;

      const chatId = (origin.to as string)?.replace("telegram:", "");
      const token  = (api.config as any)?.channels?.telegram?.botToken;
      if (!token) return;

      const pct   = Math.round((usage.totalTokens / contextWindow) * 100);
      const kUsed = Math.round(usage.totalTokens / 1000);
      const kMax  = Math.round(contextWindow / 1000);
      const footer = `📊 ${kUsed}k / ${kMax}k (${pct}%)`;

      await new Promise(r => setTimeout(r, 2000));

      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: footer, disable_notification: true }),
      });
    } catch {}
  });
}
