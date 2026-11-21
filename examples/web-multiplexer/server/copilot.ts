// examples/web-multiplexer/server/copilot.ts
// The AI co-pilot relay: one copilot request in, one suggestion out.
//
// [LAW:decomposition] Transport-free: `suggest` takes the request body as a
//   value and returns the reply as a value, so the HTTP route and any other
//   carrier answer through the same code.
// [LAW:effects-at-boundaries] The LLM call is injected; `suggest` never
//   touches the network itself.

import type { IncomingMessage } from "node:http";
import {
  parseCopilotRequest,
  type ChatMessage,
  type CopilotSuggestResponse,
} from "../shared/copilot-frame.js";

/** The largest request body the relay reads. A copilot request is a short
 *  chat transcript; anything near this size is not one. */
export const COPILOT_MAX_BODY_BYTES = 64 * 1024;

export type CompleteChat = (
  messages: readonly ChatMessage[],
) => Promise<string>;

export interface CopilotReply {
  /** 400 when the request itself is malformed; 200 otherwise, including an
   *  LLM failure, which `response` reports as `{ ok: false }`. */
  readonly status: 200 | 400;
  readonly response: CopilotSuggestResponse;
}

/** Answer one parsed request body. Never rejects: every failure is a reply. */
export async function suggest(
  body: unknown,
  complete: CompleteChat,
): Promise<CopilotReply> {
  const request = parseCopilotRequest(body);
  if (request === null) {
    return {
      status: 400,
      response: { ok: false, error: "malformed copilot request" },
    };
  }
  try {
    return {
      status: 200,
      response: { ok: true, content: await complete(request.messages) },
    };
  } catch (err) {
    return {
      status: 200,
      response: {
        ok: false,
        error: err instanceof Error ? err.message : "LLM call failed",
      },
    };
  }
}

export type CappedBody =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "too-large" }
  | { readonly kind: "stream-error"; readonly message: string };

/** Read a request body, holding at most `maxBytes` of it. Past the cap the
 *  rest is read and discarded rather than the socket destroyed, because the
 *  413 that reports it goes out on that same socket. */
export function readCappedBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<CappedBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const collect = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        req.off("data", collect);
        req.resume();
        resolve({ kind: "too-large" });
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", collect);
    req.on("end", () =>
      resolve({ kind: "ok", text: Buffer.concat(chunks).toString("utf8") }),
    );
    req.on("error", (err) =>
      resolve({ kind: "stream-error", message: err.message }),
    );
  });
}
