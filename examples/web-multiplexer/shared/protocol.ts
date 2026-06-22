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

export type ClientToServer = ExecuteRequest | SendKeysRequest | DetachRequest;

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

export interface ErrorFrame {
  readonly kind: "error";
  readonly id?: string;
  readonly message: string;
}

export interface ReadyFrame {
  readonly kind: "ready";
}

export type ServerToClient =
  | EventFrame
  | ResponseFrame
  | ErrorFrame
  | ReadyFrame;
