// examples/web-multiplexer/shared/copilot-frame.ts
// Pure wire contract for the AI co-pilot channel (HTTP POST `/copilot/suggest`).
//
// The co-pilot is the FIRST demo with an outbound effect to a third party (an
// LLM) rather than to tmux. The browser must not hold the LLM endpoint or key,
// so the network call lives in the Node bridge; this module is the request /
// response shape that crosses between them.
//
// The cut: the browser builds the chat `messages` (pure, in web/copilot-engine)
// and parses the reply (pure, same engine); the bridge does ONLY the network
// effect and returns the raw completion. So this frame carries chat messages one
// way and a completion (or a represented error) the other — it knows nothing of
// "suggestions". [LAW:effects-at-boundaries] [LAW:decomposition]
//
// [LAW:effects-at-boundaries] Pure: string/shape math only, zero IO, zero Node
//   deps. Imported by both the Node bridge (parse inbound, build response) and
//   the browser transport (build request, read response).
// [LAW:no-silent-failure] The response is a discriminated union — an `ok`
//   completion or an `error` string. The LLM being unreachable is a value the
//   UI renders, never a faked suggestion or a swallowed throw.
// [LAW:no-mode-explosion] One request shape (OpenAI-compatible chat messages),
//   not a per-provider matrix. Any OpenAI-compatible endpoint (Ollama, OpenAI,
//   LM Studio, vLLM) is reachable by configuring the bridge, not by adding a
//   variant here.

/** The HTTP path the browser POSTs a suggestion request to (proxied to the bridge). */
export const COPILOT_PATH = "/copilot/suggest";

/**
 * One chat message in the OpenAI-compatible `/v1/chat/completions` shape. The
 * browser's pure engine produces these; the bridge relays them to the LLM
 * verbatim. `assistant` is accepted for completeness though the co-pilot only
 * ever sends `system` + `user`.
 */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Browser → bridge: the chat messages to complete. */
export interface CopilotSuggestRequest {
  readonly messages: readonly ChatMessage[];
}

/**
 * Bridge → browser: the raw model completion, or a represented error. The
 * browser parses `content` into suggestions with the same pure engine that
 * built the request. [LAW:no-silent-failure] failure is `{ ok: false }`, never
 * an empty `content` masquerading as a successful-but-empty reply.
 */
export type CopilotSuggestResponse =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

/**
 * Validate an untrusted POST body into a `CopilotSuggestRequest`, or `null` if
 * it is malformed. [LAW:single-enforcer] the bridge's ONE trust boundary for
 * copilot input — a non-conforming body is rejected here, never read past.
 */
export function parseCopilotRequest(body: unknown): CopilotSuggestRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const validated: ChatMessage[] = [];
  for (const m of messages) {
    if (typeof m !== "object" || m === null) return null;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "system" && role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string") return null;
    validated.push({ role, content });
  }
  return { messages: validated };
}
