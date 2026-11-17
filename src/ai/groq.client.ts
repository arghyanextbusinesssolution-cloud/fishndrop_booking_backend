import logger from "../config/logger";

/**
 * Minimal chat-completions client (OpenAI-compatible API) with tool calling.
 * Tries in order: Groq GROQ_MODEL (default openai/gpt-oss-120b) → Gemini GEMINI_MODEL (default gemini-3.1-flash-lite then gemini-3-flash-preview,
 * key GEMINI_API_KEY) → Groq GROQ_FALLBACK_MODEL (default openai/gpt-oss-20b). Each provider is skipped when its key is missing.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const getGroqModel = () => process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";
const getFallbackModel = () => process.env.GROQ_FALLBACK_MODEL?.trim() || "openai/gpt-oss-20b";
/** Comma-separated list, tried in order (one may be busy while another answers). */
const getGeminiModels = () =>
  (process.env.GEMINI_MODEL?.trim() || "gemini-3.1-flash-lite,gemini-3-flash-preview")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
/** True when at least one AI provider (Groq or Gemini) has a key. */
export const isGroqConfigured = () => Boolean(process.env.GROQ_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim());

interface Provider {
  name: "groq" | "gemini";
  url: string;
  key: string;
  model: string;
}

/** Order: Groq main model → Gemini → Groq fallback model (only the ones with a key). */
const providerChain = (): Provider[] => {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const chain: Provider[] = [];
  if (groqKey) chain.push({ name: "groq", url: GROQ_URL, key: groqKey, model: getGroqModel() });
  if (geminiKey) for (const model of getGeminiModels()) chain.push({ name: "gemini", url: GEMINI_URL, key: geminiKey, model });
  if (groqKey && getFallbackModel() !== getGroqModel()) chain.push({ name: "groq", url: GROQ_URL, key: groqKey, model: getFallbackModel() });
  return chain;
};

export const groqChat = async (
  messages: ChatMessage[],
  tools?: ChatTool[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<{ content: string | null; toolCalls: ChatToolCall[] }> => {
  const chain = providerChain();
  if (!chain.length) throw new Error("No AI provider configured (GROQ_API_KEY / GEMINI_API_KEY)");

  let lastErr = "";
  for (const p of chain) {
    try {
      const r = await callModel(p, messages, tools, opts);
      if (p !== chain[0]) console.log(`[AI] ✅ Answered by fallback ${p.name} (${p.model})`);
      return r;
    } catch (err: any) {
      lastErr = err?.message || String(err);
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

const callModel = async (
  p: Provider,
  messages: ChatMessage[],
  tools: ChatTool[] | undefined,
  opts: { temperature?: number; maxTokens?: number }
): Promise<{ content: string | null; toolCalls: ChatToolCall[] }> => {
  const { model } = p;
  const label = p.name === "gemini" ? "Gemini" : "Groq";
  const body: Record<string, unknown> = {
    model,
    messages: p.name === "gemini" ? withThoughtSignatures(messages) : messages,
    temperature: opts.temperature ?? 0.3,
    // reasoning models spend tokens thinking before they answer
    max_tokens: opts.maxTokens ?? (p.name === "gemini" ? 4000 : 2000)
  };
  if (model.startsWith("openai/gpt-oss")) {
    body.reasoning_effort = process.env.GROQ_REASONING_EFFORT?.trim() || "low";
    body.include_reasoning = false;
  }
  if (p.name === "gemini") body.reasoning_effort = process.env.GEMINI_REASONING_EFFORT?.trim() || "low";
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
    if (p.name === "groq") body.parallel_tool_calls = false;
  }

  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
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
      lastErr = err?.name === "AbortError" ? `${label} request timed out` : err?.message || String(err);
      await sleep(700 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  logger.error(`[AI] ${label} call failed`, { model, error: lastErr });
  throw new Error(lastErr);
};
