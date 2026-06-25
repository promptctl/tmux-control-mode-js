// examples/web-multiplexer/web/llm-client.ts
// Renderer-side LLM transport — the seam between the co-pilot store and the
// bridge's `/copilot/suggest` endpoint. The store depends on the `LlmClient`
// INTERFACE, never the concrete HTTP class, so its tests inject a fake and run
// with no network. [LAW:effects-at-boundaries] [LAW:locality-or-seam]
//
// [LAW:no-silent-failure] `complete` never throws and never returns an empty
//   success: a network/proxy failure becomes `{ ok: false, error }`, the same
//   discriminated shape the bridge returns for an LLM-side failure. The store
//   renders the error; nothing is swallowed.

import {
  COPILOT_PATH,
  type ChatMessage,
  type CopilotSuggestResponse,
} from "../shared/copilot-frame.ts";

export interface LlmClient {
  /** Complete the chat messages, or report a represented error. Never throws. */
  complete(messages: readonly ChatMessage[]): Promise<CopilotSuggestResponse>;
}

/**
 * The production transport: POST the messages to the bridge, which holds the
 * endpoint + key and performs the actual LLM call. Any transport-level failure
 * (offline, proxy down, non-JSON body) is mapped to `{ ok: false }`.
 */
export class HttpLlmClient implements LlmClient {
  constructor(private readonly path: string = COPILOT_PATH) {}

  async complete(
    messages: readonly ChatMessage[],
  ): Promise<CopilotSuggestResponse> {
    try {
      const res = await fetch(this.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      if (!res.ok) {
        return { ok: false, error: `bridge returned HTTP ${res.status}` };
      }
      const body: unknown = await res.json();
      return readResponse(body);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "request failed",
      };
    }
  }
}

/** Narrow an untrusted response body to the discriminated union. */
function readResponse(body: unknown): CopilotSuggestResponse {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "malformed bridge response" };
  }
  const rec = body as Record<string, unknown>;
  if (rec.ok === true && typeof rec.content === "string") {
    return { ok: true, content: rec.content };
  }
  if (rec.ok === false && typeof rec.error === "string") {
    return { ok: false, error: rec.error };
  }
  return { ok: false, error: "malformed bridge response" };
}
