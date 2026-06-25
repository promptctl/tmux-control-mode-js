// examples/web-multiplexer/server/llm-client.ts
// The ONE outbound LLM effect. Given chat messages and a config, call an
// OpenAI-compatible `/v1/chat/completions` endpoint and return the raw
// completion text. This is the only network call in the whole demo that leaves
// the tmux world.
//
// [LAW:effects-at-boundaries] This module IS the effect — a single `fetch`.
//   Everything around it (building the messages, parsing the reply) is pure and
//   lives in the browser engine. The bridge holds the endpoint + key so the
//   browser never does.
// [LAW:no-mode-explosion] One HTTP shape (OpenAI-compatible chat), not a
//   per-provider matrix. The default is a local Ollama; ANY OpenAI-compatible
//   server is reachable by setting three env vars — no code change, no variant.
// [LAW:no-silent-failure] A non-2xx response or a reply missing the expected
//   `choices[0].message.content` THROWS with a specific message. The bridge
//   turns that into a `{ ok: false, error }` the UI shows; it is never
//   smoothed into an empty-but-successful completion.
// [LAW:zero runtime dependency] Node's global `fetch` (Node 18+) — no SDK is
//   added to reach the LLM, preserving the library's zero-dependency stance.

import type { ChatMessage } from "../shared/copilot-frame.js";

export interface LlmConfig {
  /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`. */
  readonly baseUrl: string;
  /** Model name as the endpoint knows it, e.g. `qwen3:8b` or `gpt-4o-mini`. */
  readonly model: string;
  /** Bearer token. Ollama ignores it; OpenAI requires it. Defaults to `ollama`. */
  readonly apiKey: string;
}

/**
 * Resolve the LLM config from the environment, defaulting to a local Ollama —
 * the convention a user running this demo is most likely to have. Point it at
 * any OpenAI-compatible endpoint with:
 *   COPILOT_LLM_BASE_URL  (default http://localhost:11434/v1)
 *   COPILOT_LLM_MODEL     (default qwen3:8b)
 *   COPILOT_LLM_API_KEY   (default ollama)
 * [LAW:one-source-of-truth] the endpoint lives in config, not scattered through
 *   the code; the public default is conventional, not a private address.
 */
export function llmConfigFromEnv(): LlmConfig {
  return {
    baseUrl: process.env.COPILOT_LLM_BASE_URL ?? "http://localhost:11434/v1",
    model: process.env.COPILOT_LLM_MODEL ?? "qwen3:8b",
    apiKey: process.env.COPILOT_LLM_API_KEY ?? "ollama",
  };
}

/** Low randomness — the co-pilot wants the likely next command, not novelty. */
const TEMPERATURE = 0.2;

/**
 * Call the chat-completions endpoint and return the raw completion text.
 * Throws on any failure (the caller represents it as an error to the browser).
 */
export async function chatCompletion(
  messages: readonly ChatMessage[],
  config: LlmConfig,
): Promise<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      temperature: TEMPERATURE,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `LLM endpoint ${config.baseUrl} returned HTTP ${res.status}${
        detail === "" ? "" : `: ${detail.slice(0, 200)}`
      }`,
    );
  }
  const body: unknown = await res.json();
  const content = extractContent(body);
  if (content === null) {
    throw new Error("LLM response missing choices[0].message.content");
  }
  return content;
}

/** Pull `choices[0].message.content` out of an OpenAI-compatible response body. */
function extractContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}
