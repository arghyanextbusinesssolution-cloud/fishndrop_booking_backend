import logger from "../config/logger";

/**
 * Minimal Groq chat-completions client (OpenAI-compatible API) with tool calling.
 * Key: GROQ_API_KEY. Model: GROQ_MODEL (default openai/gpt-oss-120b), GROQ_FALLBACK_MODEL (default openai/gpt-oss-20b)
 * is tried when the main model is missing, overloaded or failing.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const getGroqModel = () => process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";
const getFallbackModel = () => process.env.GROQ_FALLBACK_MODEL?.trim() || "openai/gpt-oss-20b";
export const isGroqConfigured = () => Boolean(process.env.GROQ_API_KEY?.trim());

export const groqChat = async (
  messages: ChatMessage[],
  tools?: ChatTool[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<{ content: string | null; toolCalls: ChatToolCall[] }> => {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new Error("GROQ_API_KEY is not set");

  const models = [...new Set([getGroqModel(), getFallbackModel()])];
  let lastErr = "";
  for (const model of models) {
    try {
      return await callModel(key, model, messages, tools, opts);
    } catch (err: any) {
      lastErr = err?.message || String(err);
      logger.warn("[AI] Groq model failed, trying next", { model, error: lastErr.slice(0, 200) });
    }
  }
  throw new Error(lastErr);
};

const callModel = async (
  key: string,
  model: string,
  messages: ChatMessage[],
  tools: ChatTool[] | undefined,
  opts: { temperature?: number; maxTokens?: number }
): Promise<{ content: string | null; toolCalls: ChatToolCall[] }> => {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    // reasoning models spend tokens thinking before they answer
    max_tokens: opts.maxTokens ?? 2000
  };
  if (model.startsWith("openai/gpt-oss")) {
    body.reasoning_effort = process.env.GROQ_REASONING_EFFORT?.trim() || "low";
    body.include_reasoning = false;
  }
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = false;
  }

  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      if (res.ok) {
        const json = JSON.parse(text);
        const msg = json.choices?.[0]?.message || {};
        return { content: msg.content ?? null, toolCalls: msg.tool_calls || [] };
      }
      lastErr = `Groq ${res.status}: ${text.slice(0, 300)}`;
      // 400 tool_use_failed = the model wrote a malformed tool call; a retry usually fixes it
      const retryable = res.status === 429 || res.status >= 500 || text.includes("tool_use_failed");
      if (!retryable) throw Object.assign(new Error(lastErr), { fatal: true });
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await sleep(Math.min(8000, retryAfter * 1000 || 700 * attempt));
    } catch (err: any) {
      if (err?.fatal) throw err;
      lastErr = err?.name === "AbortError" ? "Groq request timed out" : err?.message || String(err);
      await sleep(700 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  logger.error("[AI] Groq call failed", { error: lastErr });
  throw new Error(lastErr);
};
