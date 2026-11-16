// examples/web-multiplexer/web/bridge.ts
// Renderer-side bridge interface — the transport-agnostic surface every
// consumer in this app talks to. The concrete entry point picks an
// implementation:
//   - WebSocketBridge   (./ws-client.ts)            — over a Node bridge process
//   - ElectronBridge    (./electron-bridge.ts)      — over @promptctl/.../electron/renderer
//
// [LAW:one-source-of-truth] DemoStore, PaneTerminal, InspectorStore, and
// HeatmapStore all consume `TmuxBridge`, never a concrete class. The only
// site that knows the concrete type is the entry-point file that constructs
// it. Adding a method or event type here ripples through every consumer at
// compile time — there is no second consumption shape to drift from.

import type { ClientToServer } from "../shared/protocol.ts";
import type {
  ChunkPayload,
  ClientSizeSurface,
  ConnectionState,
  EmitterTmuxMessage,
} from "@promptctl/tmux-control-mode-js/browser";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";

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
 * (e.g. Electron IPC, which follows main's TmuxClient) MAY skip directly
 * from `connecting` to `ready`. The state values themselves are the contract — consumers must
 * not assume every transition fires.
 */
export type ConnState = "connecting" | "open" | "ready" | "closed";

// [LAW:one-source-of-truth] The two translations between ConnState and the
//   library's ConnectionState live together, so they cannot drift apart.

/** A library connection's state as the bridge reports it. */
export function toConnState(state: ConnectionState): ConnState {
  switch (state.status) {
    case "ready":
      return "ready";
    case "closed":
      return "closed";
    case "connecting":
    case "reconnecting":
      return "connecting";
  }
}

/** The bridge's state as a library connection reports it. */
export function toConnectionState(s: ConnState): ConnectionState {
  if (s === "ready") return { status: "ready" };
  if (s === "closed") return { status: "closed", reason: "transport-error" };
  return { status: "connecting" };
}

/**
 * One entry per thing that crossed the bridge in either direction. Powers
 * the InspectorView's wire log. Transports synthesize this on each side.
 *
 * Pane bytes and tmux's notifications cross the wire on separate channels
 * (binary frames vs JSON over WebSocket; the byte sink vs `on("*")` over
 * Electron), and the log keeps them apart: `in-output` holds one chunk of
 * pane bytes, `in-event` one notification.
 */
export type WireEntry =
  | { readonly dir: "out"; readonly ts: number; readonly msg: ClientToServer }
  | {
      readonly dir: "in-event";
      readonly ts: number;
      readonly event: EmitterTmuxMessage;
    }
  | {
      readonly dir: "in-output";
      readonly ts: number;
      readonly chunk: ChunkPayload;
    }
  | {
      readonly dir: "in-response";
      readonly ts: number;
      readonly id: string;
      readonly response: CommandResponse;
      readonly latencyMs: number;
      readonly request: ClientToServer | null;
    }
  | {
      readonly dir: "in-error";
      readonly ts: number;
      readonly id: string | null;
      readonly message: string;
    };

export type EventHandler = (event: EmitterTmuxMessage) => void;
export type PaneOutputHandler = (chunk: ChunkPayload) => void;
export type ErrorHandler = (message: string, id?: string) => void;
export type StateHandler = (state: ConnState) => void;
export type WireHandler = (entry: WireEntry) => void;

/**
 * One chunk of firehose pane bytes: which pane it came from, and the raw bytes
 * (Latin-1 decodable). The firehose taps EVERY pane in EVERY session — not just
 * the attached one — so its bytes are a separate stream from `onEvent`'s
 * attached `%output`. See `startFirehose`.
 */
export type FirehoseHandler = (paneId: number, data: Uint8Array) => void;

/**
 * Transport-agnostic bridge surface consumed by every renderer module.
 *
 * Subscription methods (`onEvent` / `onPaneOutput` / `onError` / `onState` /
 * `onWire`) all return an unsubscribe function. Calling it removes that
 * handler; calling it twice is safe.
 *
 * Lifecycle (`connect` / `disconnect`) is included on the interface because
 * DemoStore drives it from a React effect. WebSocket implementations dial
 * the URL on `connect()`; transports that are already attached at
 * construction time (Electron IPC) treat `connect()` as a no-op and ignore
 * the URL argument.
 *
 * Every command method keeps the library's `TmuxConnection` contract: a tmux
 * `%error` rejects with `TmuxCommandError`, whose `.response` carries tmux's
 * output (`.catch(asCommandResponse)` recovers it as a value); any other
 * rejection is a bridge failure.
 */
export interface TmuxBridge extends ClientSizeSurface {
  execute(command: string): Promise<CommandResponse>;
  sendKeys(target: string, keys: string): Promise<CommandResponse>;
  detach(): void;

  connect(url: string): void;
  disconnect(): void;

  onEvent(handler: EventHandler): () => void;
  onError(handler: ErrorHandler): () => void;
  onState(handler: StateHandler): () => void;
  onWire(handler: WireHandler): () => void;
  /**
   * Pane output (`%output`) for the attached session, one chunk at a time.
   * [LAW:dataflow-not-control-flow] A channel of its own, as at both
   * transports: `onEvent` carries notifications, never pane bytes.
   */
  onPaneOutput(handler: PaneOutputHandler): () => void;

  /**
   * Firehose channel — live bytes from EVERY pane in EVERY session, tapped via
   * `pipe-pane` in the bridge's host process (the browser cannot open tmux
   * connections). This is a DEDICATED channel, separate from `onPaneOutput`'s
   * attached-session `%output`: the cross-terminal regex feed sources EXCLUSIVELY from
   * here so the attached session's bytes never double-count.
   * [LAW:one-source-of-truth]
   *
   * `startFirehose` opens the taps (idempotent); `stopFirehose` closes them.
   * Bytes are delivered to every handler registered via `onFirehose` until the
   * returned disposer is called.
   */
  startFirehose(): void;
  stopFirehose(): void;
  onFirehose(handler: FirehoseHandler): () => void;
}
