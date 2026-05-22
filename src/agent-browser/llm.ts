/**
 * Shared LLM call utility.
 * Used by agent-loop.ts and task-planner.ts to avoid duplicated fetch logic.
 */

export type LLMProvider = "gemini" | "openai" | "anthropic";

export interface LLMConfig {
  provider?: LLMProvider;
  model?: string;
  api_key?: string;
  temperature?: number;
  max_tokens?: number;
}

export function detectProvider(apiKey?: string): LLMProvider {
  if (apiKey || process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  throw new Error("No LLM API key found. Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.");
}

/** Call an LLM with a simple user prompt. Returns the text response. */
export async function callLLM(
  prompt: string,
  config: LLMConfig = {},
): Promise<string> {
  const provider = config.provider ?? detectProvider(config.api_key);
  const temperature = config.temperature ?? 0.0;
  const maxTokens = config.max_tokens ?? 1024;

  if (provider === "gemini") {
    const key = config.api_key ?? process.env.GEMINI_API_KEY!;
    const model = config.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generation_config: { temperature, max_output_tokens: maxTokens },
        }),
      },
    );
    const data = await res.json() as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  if (provider === "openai") {
    const key = config.api_key ?? process.env.OPENAI_API_KEY!;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: config.model ?? "gpt-4o-mini",
        temperature,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content ?? "";
  }

  if (provider === "anthropic") {
    const key = config.api_key ?? process.env.ANTHROPIC_API_KEY!;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: config.model ?? "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json() as any;
    return data.content?.[0]?.text ?? "";
  }

  throw new Error(`Unknown provider: ${provider}`);
}

/** Call an LLM with a multi-turn message history. Returns the text response. */
export async function callLLMMessages(
  messages: Array<{ role: string; content: string }>,
  config: LLMConfig = {},
): Promise<string> {
  const provider = config.provider ?? detectProvider(config.api_key);
  const temperature = config.temperature ?? 0.1;
  const maxTokens = config.max_tokens ?? 1024;

  if (provider === "gemini") {
    const key = config.api_key ?? process.env.GEMINI_API_KEY!;
    const model = config.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents, generation_config: { temperature, max_output_tokens: maxTokens } }),
      },
    );
    const data = await res.json() as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  if (provider === "openai") {
    const key = config.api_key ?? process.env.OPENAI_API_KEY!;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ model: config.model ?? "gpt-4o-mini", temperature, messages }),
    });
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content ?? "";
  }

  if (provider === "anthropic") {
    const key = config.api_key ?? process.env.ANTHROPIC_API_KEY!;
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const userMsgs = messages.filter((m) => m.role !== "system");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: config.model ?? "claude-haiku-4-5-20251001", max_tokens: maxTokens, system, messages: userMsgs }),
    });
    const data = await res.json() as any;
    return data.content?.[0]?.text ?? "";
  }

  throw new Error(`Unknown provider: ${provider}`);
}

/** Extract first JSON object or array from an LLM response string. */
export function parseJSON<T>(text: string, fallback: T): T {
  const match = text.match(/[\[{][\s\S]*[\]}]/);
  if (!match) return fallback;
  try { return JSON.parse(match[0]) as T; }
  catch { return fallback; }
}
