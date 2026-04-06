// examples/web-multiplexer/shared/protocol.ts
// WebSocket wire protocol between the bridge server and the browser.
//
// [LAW:one-source-of-truth] These types are the authoritative contract
// between server and browser. Both import from here.
//
// Types-only imports from tmux-control-mode-js. No runtime code from the
// library crosses into the browser bundle (enforced by build + DEMO-02).

import type { TmuxMessage, CommandResponse } from "../../../src/protocol/types.js";

/**
 * A TmuxMessage serialized for JSON transport. Pane `output` and
 * `extended-output` messages carry `Uint8Array` data on the server side;
 * we transport them as base64 strings and decode in the browser.
 */
export type SerializedTmuxMessage =
  | Exclude<TmuxMessage, { type: "output" } | { type: "extended-output" }>
  | { readonly type: "output"; readonly paneId: number; readonly dataBase64: string }
  | {
      readonly type: "extended-output";
      readonly paneId: number;
      readonly age: number;
      readonly dataBase64: string;
    };

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

export interface EventFrame {
  readonly kind: "event";
  readonly event: SerializedTmuxMessage;
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

export type ServerToClient = EventFrame | ResponseFrame | ErrorFrame | ReadyFrame;
