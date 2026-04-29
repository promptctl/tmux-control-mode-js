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
  CommandResponse,
  PaneAction,
  TmuxMessage,
} from "../../../src/protocol/types.js";

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
 * the InspectorView's wire log. Transports synthesize this on each side.
 *
 * Note: `in-event.event` is a fully-decoded TmuxMessage (Uint8Array bytes
 * for output / extended-output). Wire-side encodings such as base64 in the
 * WebSocket JSON frame are a transport detail — the inspector renders the
 * bytes directly.
 */
export type WireEntry =
  | { readonly dir: "out"; readonly ts: number; readonly msg: ClientToServer }
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
      readonly request: ClientToServer | null;
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
export type WireHandler = (entry: WireEntry) => void;

/**
 * Transport-agnostic bridge surface consumed by every renderer module.
 *
 * Subscription methods (`onEvent` / `onError` / `onState` / `onWire`) all
 * return an unsubscribe function. Calling it removes that handler; calling
 * it twice is safe.
 *
 * Lifecycle (`connect` / `disconnect`) is included on the interface because
 * DemoStore drives it from a React effect. WebSocket implementations dial
 * the URL on `connect()`; transports that are already attached at
 * construction time (Electron IPC) treat `connect()` as a no-op and ignore
 * the URL argument.
 */
export interface TmuxBridge {
  execute(command: string): Promise<CommandResponse>;
  sendKeys(target: string, keys: string): Promise<CommandResponse>;
  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse>;
  detach(): void;

  connect(url: string): void;
  disconnect(): void;

  onEvent(handler: EventHandler): () => void;
  onError(handler: ErrorHandler): () => void;
  onState(handler: StateHandler): () => void;
  onWire(handler: WireHandler): () => void;
}
