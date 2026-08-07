/**
 * Operator-owned LLM stack for the decision layer (shared across users): any
 * OpenAI-compatible provider configured via env (key, base URL, model), with a
 * short per-attempt budget so the watch loop stays fast when it's slow.
 */
import OpenAI from "openai";
import type { LlmConfig } from "@guardian/src/agent/guardian.js";

export function loadServerLlm(): LlmConfig | null {
  const llmKey = process.env.LLM_API_KEY;
  const llmBaseUrl = process.env.LLM_BASE_URL;
  const llmModel = process.env.LLM_MODEL;
  if (!llmKey || llmKey.includes("your_") || !llmBaseUrl || !llmModel) return null;
  return {
    client: new OpenAI({
      apiKey: llmKey,
      baseURL: llmBaseUrl,
    }),
    model: llmModel,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 15000),
  };
}
