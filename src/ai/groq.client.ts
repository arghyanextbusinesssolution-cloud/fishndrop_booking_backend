import logger from "../config/logger";

/**
 * Minimal chat-completions client (OpenAI-compatible API) with tool calling.
 * Tries every free-tier model one by one until one answers: Groq GROQ_MODEL list → Gemini GEMINI_MODEL list →
 * Groq GROQ_FALLBACK_MODEL list → OpenAI OPENAI_MODEL list (last resort, key OPENAI_API_KEY) (all comma-separated). Models out of quota / busy are skipped for a while (cooldown).
 * A provider is skipped entirely when its key (GROQ_API_KEY / GEMINI_API_KEY) is missing.
 */

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Gemini's OpenAI-compatible endpoint (same request/response shape, incl. tool calls)
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
// Last resort when every Groq + Gemini model failed (paid key — only used then)
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Comma-separated env list → model ids, tried in order. */
const list = (v: string | undefined, fallback: string) =>
  (v?.trim() || fallback)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

// Every free-tier model that supports tool calling (checked Nov 2026). Override with GROQ_MODEL / GEMINI_MODEL / GROQ_FALLBACK_MODEL.
const getGroqModels = () => list(process.env.GROQ_MODEL, "openai/gpt-oss-120b,qwen/qwen3.8-27b");
const getGeminiModels = () =>
  list(
    process.env.GEMINI_MODEL,
    "gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3-flash-preview,gemini-flash-latest,gemini-3.1-pro-preview,gemini-pro-latest"
  );
const getGroqFallbackModels = () => list(process.env.GROQ_FALLBACK_MODEL, "openai/gpt-oss-20b");
const getOpenAiModels = () => list(process.env.OPENAI_MODEL, "gpt-4.1-mini,gpt-4o-mini");
export const getGroqModel = () => getGroqModels()[0];

/**
 * Models that just failed are skipped for a while so each customer message doesn't wait on dead ends:
 * daily quota used up → 30 min, busy/rate-limited → 1 min, model not available → 24 h.
 */
const cooldownUntil = new Map<string, number>();
const coolDown = (p: Provider, err: string) => {
  const mins = /no longer available|not found|not supported|404/i.test(err)
    ? 24 * 60
    : /per day|TPD|RPD|quota/i.test(err)
      ? 30
      : /429|503|high demand|overloaded|timed out/i.test(err)
        ? 1
        : 0;
  if (mins) cooldownUntil.set(`${p.name}:${p.model}`, Date.now() + mins * 60 * 1000);
};
const isCooling = (p: Provider) => (cooldownUntil.get(`${p.name}:${p.model}`) || 0) > Date.now();
/** True when at least one AI provider (Groq, Gemini or OpenAI) has a key. */
export const isGroqConfigured = () =>
  Boolean(process.env.GROQ_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());

interface Provider {
  name: "groq" | "gemini" | "openai";
  url: string;
  key: string;
  model: string;
}

/** Order: Groq models → every Gemini model → Groq fallback models (only providers with a key). */
const providerChain = (): Provider[] => {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const chain: Provider[] = [];
  const add = (name: Provider["name"], url: string, key: string | undefined, models: string[]) => {
    if (!key) return;
    for (const model of models) if (!chain.some((c) => c.name === name && c.model === model)) chain.push({ name, url, key, model });
  };
  add("groq", GROQ_URL, groqKey, getGroqModels());
  add("gemini", GEMINI_URL, geminiKey, getGeminiModels());
  add("groq", GROQ_URL, groqKey, getGroqFallbackModels());
  add("openai", OPENAI_URL, process.env.OPENAI_API_KEY?.trim(), getOpenAiModels()); // last resort
  return chain;
};

export const groqChat = async (
  messages: ChatMessage[],
  tools?: ChatTool[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<{ content: string | null; toolCalls: ChatToolCall[] }> => {
  const chain = providerChain();
  if (!chain.length) throw new Error("No AI provider configured (GROQ_API_KEY / GEMINI_API_KEY)");

  // Skip models that are cooling down — unless every model is, then try them all anyway
  const ready = chain.filter((p) => !isCooling(p));
  const order = ready.length ? ready : chain;

  let lastErr = "";
  for (const p of order) {
    try {
      const r = await callModel(p, messages, tools, opts);
      cooldownUntil.delete(`${p.name}:${p.model}`);
      if (p !== chain[0]) console.log(`[AI] ✅ Answered by ${p.name} (${p.model})`);
      return r;
    } catch (err: any) {
      lastErr = err?.message || String(err);
      coolDown(p, lastErr);
      logger.warn("[AI] model failed, trying next provider", { provider: p.name, model: p.model, error: lastErr.slice(0, 200) });
    }
  }
  throw new Error(lastErr);
};

/**
 * Gemini 3 requires a "thought signature" on earlier tool calls. Calls made by Groq earlier in the same turn
 * don't have one, so they get Google's documented placeholder that skips the check.
 */
const withThoughtSignatures = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((m) =>
    m.role === "assistant" && m.tool_calls?.length
      ? {
          ...m,
          tool_calls: m.tool_calls.map((tc: any) =>
            tc.extra_content?.google?.thought_signature
              ? tc
              : { ...tc, extra_content: { google: { thought_signature: "skip_thought_signature_validator" } } }
          )
        }
      : m
  );

/** Tool calls without provider-specific extras (OpenAI only accepts id / type / function). */
const withoutExtraContent = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((m) =>
    m.role === "assistant" && m.tool_calls?.length
      ? { ...m, tool_calls: m.tool_calls.map((tc) => ({ id: tc.id, type: tc.type, function: tc.function })) }
      : m
  );

const callModel = async (
  p: Provider,
  messages: ChatMessage[],
  tools: ChatTool[] | undefined,
  opts: { temperature?: number; maxTokens?: number }
): Promise<{ content: string | null; toolCalls: ChatToolCall[] }> => {
  const { model } = p;
  const label = p.name === "gemini" ? "Gemini" : p.name === "openai" ? "OpenAI" : "Groq";
  const body: Record<string, unknown> = {
    model,
    // OpenAI rejects Gemini's extra_content on tool calls → strip it; Gemini needs thought signatures
    messages: p.name === "gemini" ? withThoughtSignatures(messages) : p.name === "openai" ? withoutExtraContent(messages) : messages,
    temperature: opts.temperature ?? 0.3
  };
  // reasoning models spend tokens thinking before they answer
  if (p.name === "openai") body.max_completion_tokens = opts.maxTokens ?? 2000;
  else body.max_tokens = opts.maxTokens ?? (p.name === "gemini" ? 4000 : 2000);
  if (model.startsWith("openai/gpt-oss")) {
    body.reasoning_effort = process.env.GROQ_REASONING_EFFORT?.trim() || "low";
    body.include_reasoning = false;
  }
  // Qwen thinks out loud by default — keep the thinking out of the customer's reply
  if (model.startsWith("qwen/")) body.reasoning_format = "hidden";
  if (p.name === "gemini") body.reasoning_effort = process.env.GEMINI_REASONING_EFFORT?.trim() || "low";
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
    if (p.name !== "gemini") body.parallel_tool_calls = false;
  }

  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      if (res.ok) {
        const json = JSON.parse(text);
        const msg = json.choices?.[0]?.message || {};
        return { content: msg.content ?? null, toolCalls: msg.tool_calls || [] };
      }
      lastErr = `${label} ${res.status}: ${text.slice(0, 300)}`;
      // Daily quota used up → retrying is pointless, move to the next provider right away
      const quotaGone = res.status === 429 && /per day|TPD|RPD|quota/i.test(text);
      // 400 tool_use_failed = the model wrote a malformed tool call; a retry usually fixes it
      const retryable = !quotaGone && (res.status === 429 || res.status >= 500 || text.includes("tool_use_failed"));
      if (!retryable) throw Object.assign(new Error(lastErr), { fatal: true });
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await sleep(Math.min(8000, retryAfter * 1000 || 700 * attempt));
    } catch (err: any) {
      if (err?.fatal) throw err;
      // A hung model: don't keep the customer waiting — move on to the next model right away
      if (err?.name === "AbortError") throw new Error(`${label} request timed out (${model})`);
      lastErr = err?.message || String(err);
      await sleep(700 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  logger.error(`[AI] ${label} call failed`, { model, error: lastErr });
  throw new Error(lastErr);
};
