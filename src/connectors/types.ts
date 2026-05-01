// src/connectors/types.ts
// Shared connector surface — promoted from the web-multiplexer demo so every
// renderer-side bridge implementation talks to the same `TmuxBridge` shape.
//
// This file owns:
//   - `ConnState`: the four-state lifecycle every bridge consumer observes.
//   - `WireEntry<TRequest>`: an observability tap entry, generic over the
//     transport's outbound-request shape so consumers can specialize the
//     payload type for their inspector/log view (e.g. with `RpcRequest`
//     from `./rpc.js`) without redeclaring the union.
//   - `TmuxBridge<TRequest>`: the transport-agnostic bridge contract every
//     consumer (terminal sinks, topology stores, inspectors) uses.
//
// What this file is NOT:
//   - It is NOT a re-implementation of `RpcProxyApi` from `./rpc.js`.
//     `RpcProxyApi` is the FULL bridged TmuxClient surface (every method
//     the wire RPC envelope can carry). `TmuxBridge` is intentionally a
//     narrower consumer-facing surface — the methods a UI actually drives —
//     plus lifecycle + subscriber semantics. A bridge adapter that wraps a
//     library proxy (Electron's `TmuxClientProxy`, the WebSocket
//     `WebSocketTmuxClient`) forwards that subset and adds the lifecycle +
//     wire-tap surface this interface requires.
//
// [LAW:one-source-of-truth] `TmuxBridge`, `ConnState`, and `WireEntry` are
// declared once. Every concrete bridge (Electron, WebSocket, future) and
// every consumer imports from here.
// [LAW:locality-or-seam] This module IS the seam between transport and
// consumer. Adding a transport = implementing the interface. Adding a
// consumer = importing it. No other coupling shape is permitted.

import type {
  CommandResponse,
  PaneAction,
  TmuxMessage,
} from "../protocol/types.js";

/**
 * Connection state observed by every consumer that cares about the
 * transport's liveness. The four-state machine is:
 *
 *   connecting → open → ready → closed
 *
 *   - `connecting` — initial; transport is opening
 *   - `open`       — transport is up but tmux handshake hasn't settled
 *   - `ready`      — tmux handshake done; subscriptions can be installed
 *   - `closed`     — transport torn down (graceful or otherwise)
 *
 * Transports that have no separate "open vs handshake-done" distinction
 * (e.g. Electron IPC, where the proxy is constructed against an
 * already-attached TmuxClient) MAY skip directly from `connecting` to
 * `ready`. The state values themselves are the contract — consumers must
 * not assume every transition fires.
 */
export type ConnState = "connecting" | "open" | "ready" | "closed";

/**
 * One entry per thing that crossed the bridge in either direction. Powers
 * inspector/wire-log views. Transports synthesize this on each side.
 *
 * The type parameter `TRequest` lets a consumer specialize the request
 * envelope it sees on `out` and `in-response` entries. The library default
 * is `unknown` so the union can be carried across boundaries that don't
 * know the transport's framing; consumers that want a typed inspector
 * specialize with the bridged-method shape they care about (e.g.
 * `RpcRequest` from `./rpc.js`, or that augmented with a correlation id).
 *
 * `in-event.event` is a fully-decoded `TmuxMessage` (Uint8Array bytes for
 * output / extended-output). Wire-side encodings such as base64 in a JSON
 * frame are a transport detail — the inspector renders the bytes directly.
 */
export type WireEntry<TRequest = unknown> =
  | { readonly dir: "out"; readonly ts: number; readonly msg: TRequest }
  | {
      readonly dir: "in-event";
      readonly ts: number;
      readonly event: TmuxMessage;
    }
  | {
      readonly dir: "in-response";
      readonly ts: number;
      readonly id: string;
      readonly response: CommandResponse;
      readonly latencyMs: number;
      readonly request: TRequest | null;
    }
  | {
      readonly dir: "in-error";
      readonly ts: number;
      readonly id: string | null;
      readonly message: string;
    };

export type EventHandler = (event: TmuxMessage) => void;
export type ErrorHandler = (message: string, id?: string) => void;
export type StateHandler = (state: ConnState) => void;
export type WireHandler<TRequest = unknown> = (
  entry: WireEntry<TRequest>,
) => void;

/**
 * Transport-agnostic bridge surface consumed by every renderer-side module
 * that drives tmux. Two implementations live in the demo today; future
 * transports (e.g. a remote-mirror viewer) implement this same interface.
 *
 * Subscription methods (`onEvent` / `onError` / `onState` / `onWire`) all
 * return an unsubscribe function. Calling it removes that handler; calling
 * it twice is safe.
 *
 * `onState` MUST invoke its handler synchronously with the current state on
 * subscription so consumers don't miss the initial value when subscribing
 * after a transition has already fired. The other subscribers are passive —
 * they only fire on subsequent activity.
 *
 * Lifecycle (`connect` / `disconnect`) is on the interface because consumers
 * drive it from React effects. WebSocket implementations dial the URL on
 * `connect()`; transports that are already attached at construction time
 * (Electron IPC) treat `connect()` as a no-op and ignore the URL argument.
 */
export interface TmuxBridge<TRequest = unknown> {
  execute(command: string): Promise<CommandResponse>;
  sendKeys(target: string, keys: string): Promise<CommandResponse>;
  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse>;
  detach(): void;

  connect(url: string): void;
  disconnect(): void;

  onEvent(handler: EventHandler): () => void;
  onError(handler: ErrorHandler): () => void;
  onState(handler: StateHandler): () => void;
  onWire(handler: WireHandler<TRequest>): () => void;
}
