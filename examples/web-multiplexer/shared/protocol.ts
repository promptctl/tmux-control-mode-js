// examples/web-multiplexer/shared/protocol.ts
// WebSocket wire protocol between the bridge server and the browser.
//
// [LAW:one-source-of-truth] These types are the authoritative contract
// between server and browser. Both import from here.
//
// Types-only imports from tmux-control-mode-js. No runtime code from the
// library crosses into the browser bundle (enforced by build + DEMO-02).

import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import type { EmitterTmuxMessage } from "@promptctl/tmux-control-mode-js";
import type { BridgeErrorCode } from "@promptctl/tmux-control-mode-js/websocket/protocol";

// ---------------------------------------------------------------------------
// Browser → Server
// ---------------------------------------------------------------------------

export interface ExecuteRequest {
  readonly kind: "execute";
  readonly id: string;
  readonly command: string;
}

export interface SendKeysRequest {
  readonly kind: "sendKeys";
  readonly id: string;
  readonly target: string;
  readonly keys: string;
}

export interface DetachRequest {
  readonly kind: "detach";
  readonly id: string;
}

/**
 * Open / close the cross-terminal firehose (live bytes from every pane in every
 * session). Like `detach`, these are fire-and-forget — no response frame — but
 * they carry an `id` so every ClientToServer message is uniformly correlatable
 * in the inspector wire log. The bytes themselves arrive as binary firehose
 * frames (see shared/firehose-frame.ts), not on the JSON channel.
 */
export interface StartFirehoseRequest {
  readonly kind: "startFirehose";
  readonly id: string;
}

export interface StopFirehoseRequest {
  readonly kind: "stopFirehose";
  readonly id: string;
}

export type ClientToServer =
  | ExecuteRequest
  | SendKeysRequest
  | DetachRequest
  | StartFirehoseRequest
  | StopFirehoseRequest;

// ---------------------------------------------------------------------------
// Server → Browser
// ---------------------------------------------------------------------------

/**
 * A non-byte tmux event (session/window/pane state). Pane `output` /
 * `extended-output` bytes do NOT ride this JSON channel — they travel as
 * binary pane-output frames (see `attachWebSocketSink` on the server and
 * `decodePaneOutput` in the browser). `EmitterTmuxMessage` is the library's
 * `Exclude<TmuxMessage, PaneOutputMessage>`, so this frame is type-level
 * incapable of carrying bytes. [LAW:types-are-the-program]
 */
export interface EventFrame {
  readonly kind: "event";
  readonly event: EmitterTmuxMessage;
}

export interface ResponseFrame {
  readonly kind: "response";
  readonly id: string;
  readonly response: CommandResponse;
}

/** A failure the server reports. One that answers a command carries the
 *  command's id and the code its BridgeError rejects with. */
export type ErrorFrame =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "error";
      readonly id: string;
      readonly code: BridgeErrorCode;
      readonly message: string;
    };

export interface ReadyFrame {
  readonly kind: "ready";
}

export type ServerToClient =
  | EventFrame
  | ResponseFrame
  | ErrorFrame
  | ReadyFrame;
