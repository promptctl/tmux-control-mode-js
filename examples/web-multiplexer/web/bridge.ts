// examples/web-multiplexer/web/bridge.ts
// Renderer-side bridge interface — the transport-agnostic surface every
// consumer in this app talks to. One implementation, `LibraryBridge`
// (./library-bridge.ts), runs over either library connection; the entry point
// picks the transport:
//   - webSocketBridge   (./ws-bridge.ts)        — the library WebSocket connector
//   - electronBridge    (./electron-bridge.ts)  — the library Electron connector
//
// [LAW:one-source-of-truth] DemoStore, PaneTerminal, InspectorStore, and
// HeatmapStore all consume `TmuxBridge`, never a concrete class. The only
// site that knows the concrete type is the entry-point file that constructs
// it. Adding a method or event type here ripples through every consumer at
// compile time — there is no second consumption shape to drift from.

import type {
  ChunkPayload,
  ClientSizeSurface,
  ConnectionState,
  EmitterTmuxMessage,
} from "@promptctl/tmux-control-mode-js/browser";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";

/**
 * One command the page sent, as the wire log shows it. A size call logs as the
 * `execute` of the `refresh-client` command it amounts to.
 */
export type BridgeCall =
  | { readonly kind: "execute"; readonly id: string; readonly command: string }
  | {
      readonly kind: "sendKeys";
      readonly id: string;
      readonly target: string;
      readonly keys: string;
    };

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
  | { readonly dir: "out"; readonly ts: number; readonly call: BridgeCall }
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
      readonly call: BridgeCall;
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
export type StateHandler = (state: ConnectionState) => void;
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
 * DemoStore drives it from a React effect. `connect()` opens a connection
 * when there is none or the last one has closed, and does nothing while one
 * is live; the transport's address is fixed when the bridge is built.
 * `onState` reports the library's `ConnectionState`, as both connectors do.
 *
 * Every command method keeps the library's `TmuxConnection` contract: a tmux
 * `%error` rejects with `TmuxCommandError`, whose `.response` carries tmux's
 * output (`.catch(asCommandResponse)` recovers it as a value); any other
 * rejection is a bridge failure.
 */
export interface TmuxBridge extends ClientSizeSurface {
  execute(command: string): Promise<CommandResponse>;
  sendKeys(target: string, keys: string): Promise<CommandResponse>;

  connect(): void;
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
   * Over WebSocket the taps live exactly as long as their own socket.
   * Bytes are delivered to every handler registered via `onFirehose` until the
   * returned disposer is called.
   */
  startFirehose(): void;
  stopFirehose(): void;
  onFirehose(handler: FirehoseHandler): () => void;
}
