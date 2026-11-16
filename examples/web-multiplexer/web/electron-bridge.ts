// examples/web-multiplexer/web/electron-bridge.ts
// Electron-IPC implementation of TmuxBridge — wraps the library's
// renderer-side TmuxClientProxy so the unified web-multiplexer renderer
// can drive tmux over Electron IPC instead of (or alongside) WebSocket.
//
// [LAW:single-enforcer] One adapter, one boundary. The proxy is the
// single in-renderer surface that talks to the main process; this file
// is the single place that adapts the proxy's shape to TmuxBridge.
//
// [LAW:dataflow-not-control-flow] Method calls and events run the same
// pipeline every time:
//   - methods: synthesize ClientToServer → emit "out" wire → invoke proxy
//     → emit "in-response" wire (a tmux %error included), or "in-error"
//     when the bridge itself fails
//   - events:  proxy.on("*") → emit "in-event" wire → fan out to handlers
// No branching on "is this a special method" or "is this a special event".

import {
  createRendererBridge,
  type IpcRendererLike,
  type TmuxClientProxy,
} from "@promptctl/tmux-control-mode-js/electron/renderer";
// [LAW:one-way-deps] Browser-safe core only — the `/browser` subpath carries
// no Node transport coupling (see pane-stream-bridge.ts).
import {
  TmuxCommandError,
  isTmuxMessage,
  serverScope,
} from "@promptctl/tmux-control-mode-js/browser";
import type {
  ChunkPayload,
  EmitterMessage,
} from "@promptctl/tmux-control-mode-js/browser";
import type {
  CommandResponse,
  TmuxMessage,
} from "@promptctl/tmux-control-mode-js/protocol";
import {
  refreshClientClearWindowSize,
  refreshClientSize,
  refreshClientWindowSize,
} from "@promptctl/tmux-control-mode-js/protocol";
import type { ClientToServer } from "../shared/protocol.ts";
import type { DemoIpc } from "./demo-ipc.ts";
import type {
  ConnState,
  ErrorHandler,
  EventHandler,
  FirehoseHandler,
  StateHandler,
  TmuxBridge,
  WireEntry,
  WireHandler,
} from "./bridge.ts";
import { toConnState } from "./bridge.ts";

export class ElectronBridge implements TmuxBridge {
  private readonly ipcRenderer: IpcRendererLike;
  private readonly proxyEventHandler: (msg: EmitterMessage) => void;
  private proxy: TmuxClientProxy | null = null;
  // [LAW:single-enforcer] Disposer for the proxy byte-sink that re-surfaces
  // pane output as `output` events. One sink per live proxy; cleared on
  // disconnect alongside the proxy.
  private byteSinkDisposer: (() => void) | null = null;
  private state: ConnState = "connecting";
  private nextId = 0;
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly wireHandlers = new Set<WireHandler>();
  private readonly firehoseHandlers = new Set<FirehoseHandler>();
  // [LAW:single-enforcer] One demo-IPC firehose subscription, fanned out to
  // every onFirehose handler. The demoIpc surface is the Electron analogue of
  // the WebSocket binary firehose frame.
  private readonly demoIpc: DemoIpc;

  constructor(ipcRenderer: IpcRendererLike, demoIpc: DemoIpc) {
    this.ipcRenderer = ipcRenderer;
    this.demoIpc = demoIpc;
    // Persistent fan-out: bytes pushed from the main process reach every
    // registered handler. Lives for the bridge's lifetime (one per page).
    this.demoIpc.onFirehose((paneId, data) => {
      this.firehoseHandlers.forEach((h) => h(paneId, data));
    });
    // [LAW:single-enforcer] One proxy.on("*") subscription per connect()
    // — every event fans out to local handlers + the wire stream from
    // this single source. Storing the bound handler at construction time
    // means each connect/disconnect cycle uses the SAME closure identity
    // so removeListener pairs cleanly with on().
    //
    // [LAW:one-type-per-behavior] The lifecycle filter lives HERE, at the
    // emitter source — the one inbound path that can carry synthetic
    // events. The demo consumes only tmux's own messages, so `deliverEvent`
    // downstream speaks one honest TmuxMessage shape.
    // [LAW:one-source-of-truth] The bridge is ready while main's tmux client
    //   is: main forwards that client's connection-state, so a drop there
    //   reaches onState like a WebSocket close does.
    this.proxyEventHandler = (msg) => {
      if (msg.type === "connection-state") {
        this.setState(toConnState(msg.state));
        return;
      }
      if (!isTmuxMessage(msg)) return;
      this.deliverEvent(msg);
    };
  }

  // ---------------------------------------------------------------------------
  // RPC methods
  // ---------------------------------------------------------------------------

  execute(command: string): Promise<CommandResponse> {
    const request: ClientToServer = {
      kind: "execute",
      id: this.allocId(),
      command,
    };
    return this.invokeWithWire(request, (proxy) => proxy.execute(command));
  }

  // Every renderer shares the main process's tmux client, so a size goes
  // through the library bridge's claim for this renderer, which the bridge
  // withdraws when the renderer goes. The wire log shows the tmux command.
  setSize(width: number, height: number): Promise<CommandResponse> {
    return this.invokeWithWire(
      {
        kind: "execute",
        id: this.allocId(),
        command: refreshClientSize(width, height),
      },
      (proxy) => proxy.setSize(width, height),
    );
  }

  setWindowSize(
    windowId: number,
    width: number,
    height: number,
  ): Promise<CommandResponse> {
    return this.invokeWithWire(
      {
        kind: "execute",
        id: this.allocId(),
        command: refreshClientWindowSize(windowId, width, height),
      },
      (proxy) => proxy.setWindowSize(windowId, width, height),
    );
  }

  clearWindowSize(windowId: number): Promise<CommandResponse> {
    return this.invokeWithWire(
      {
        kind: "execute",
        id: this.allocId(),
        command: refreshClientClearWindowSize(windowId),
      },
      (proxy) => proxy.clearWindowSize(windowId),
    );
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    const request: ClientToServer = {
      kind: "sendKeys",
      id: this.allocId(),
      target,
      keys,
    };
    return this.invokeWithWire(request, (proxy) =>
      proxy.sendKeys(target, keys),
    );
  }

  /**
   * No-op on Electron. WebSocketBridge.detach asks the bridge server to
   * close its TmuxClient, which detaches every connected renderer; the
   * Electron equivalent is an admin operation the main process owns
   * (it holds the TmuxClient handle). The renderer-side proxy
   * intentionally does not expose `detach` — see
   * src/connectors/electron/renderer.ts on why. The demo's renderer
   * does not call this method today; this stub exists to satisfy the
   * TmuxBridge interface.
   */
  detach(): void {
    // intentional no-op
  }

  /**
   * [LAW:no-silent-failure] A firehose start failure (e.g. no active client in
   * the main process) is surfaced through the error handlers, then swallowed at
   * the Promise edge so a fire-and-forget caller doesn't trip an unhandled
   * rejection. The renderer reflects the failure via onError, never silently.
   */
  startFirehose(): void {
    this.demoIpc.startFirehose().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.errorHandlers.forEach((h) => h(`firehose: ${message}`));
    });
  }

  stopFirehose(): void {
    this.demoIpc.stopFirehose().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.errorHandlers.forEach((h) => h(`firehose: ${message}`));
    });
  }

  onFirehose(h: FirehoseHandler): () => void {
    this.firehoseHandlers.add(h);
    return () => {
      this.firehoseHandlers.delete(h);
    };
  }

  /**
   * Open the proxy and announce readiness. Idempotent — a second connect
   * while a proxy is live is a no-op. The URL argument is ignored: IPC
   * has no URL to dial; the renderer's tmux session is whichever one the
   * main process attached to.
   *
   * Lazy proxy creation lets a renderer cycle through connect/disconnect/
   * connect (e.g. React StrictMode dev double-mount, or a "reconnect"
   * UI affordance) without leaking a dead proxy or duplicate IPC
   * handlers.
   */
  connect(_url: string): void {
    if (this.proxy !== null) return;
    const proxy = createRendererBridge(this.ipcRenderer);
    proxy.on("*", this.proxyEventHandler);
    // [LAW:single-enforcer] The renderer proxy delivers pane bytes ONLY through
    // its byte-sink channel (`attachBytesSink`) — it does NOT re-emit them on
    // `on("*")`, which carries non-byte EmitterMessages. So bridge the byte
    // channel back into the unified event stream: each chunk becomes an
    // `output` TmuxMessage routed through `deliverEvent`, exactly mirroring the
    // WebSocket transport (which decodes binary frames into the same `output`
    // message and delivers them through its event fan-out + wire log). Without
    // this, BridgePaneStreamClient — which consumes pane bytes via
    // `bridge.onEvent("output")` — would never see live pane output.
    // [LAW:one-source-of-truth] With only this server-scope sink, the proxy's
    //   router keeps no topology and sends no query: BridgePaneStreamClient's
    //   router is the page's one topology, and it outlives the proxy that a
    //   socket swap replaces.
    this.byteSinkDisposer = proxy.attachBytesSink(
      {
        write: (chunk: ChunkPayload): void => {
          // [LAW:one-type-per-behavior] An `output` message is already a
          // TmuxMessage — no lifecycle filter needed on this synthetic path.
          this.deliverEvent({
            type: "output",
            paneId: chunk.paneId,
            data: chunk.data,
          });
        },
        end: (): void => {
          // no-op: pane output is pushed per chunk; there is no frame to flush.
        },
      },
      { scope: serverScope },
    );
    this.proxy = proxy;
    // [LAW:one-source-of-truth] The proxy holds main's connection state; the
    //   bridge reads it once subscribed and follows its transitions after,
    //   so the result does not depend on when main's snapshot is delivered
    //   (Electron delivers it in a later task; the in-memory test hub
    //   delivers it before the subscription exists).
    this.setState(toConnState(proxy.connectionState));
  }

  disconnect(): void {
    const proxy = this.proxy;
    if (proxy === null) return;
    this.proxy = null;
    this.byteSinkDisposer?.();
    this.byteSinkDisposer = null;
    proxy.off("*", this.proxyEventHandler);
    proxy.close();
    this.setState("closed");
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  onEvent(h: EventHandler): () => void {
    this.eventHandlers.add(h);
    return () => {
      this.eventHandlers.delete(h);
    };
  }

  onError(h: ErrorHandler): () => void {
    this.errorHandlers.add(h);
    return () => {
      this.errorHandlers.delete(h);
    };
  }

  onState(h: StateHandler): () => void {
    this.stateHandlers.add(h);
    h(this.state);
    return () => {
      this.stateHandlers.delete(h);
    };
  }

  onWire(h: WireHandler): () => void {
    this.wireHandlers.add(h);
    return () => {
      this.wireHandlers.delete(h);
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Single delivery path for an inbound event — proxy state events (filtered
   * to TmuxMessages at the emitter source) and decoded pane-output bytes both
   * flow through here, so every consumer and the in-event WireEntry see one
   * uniform TmuxMessage shape, identical to the WebSocket transport's
   * deliverEvent. [LAW:one-type-per-behavior]
   */
  private deliverEvent(ev: TmuxMessage): void {
    this.emitWire({ dir: "in-event", ts: Date.now(), event: ev });
    this.eventHandlers.forEach((h) => h(ev));
  }

  private async invokeWithWire(
    request: ClientToServer,
    invoker: (proxy: TmuxClientProxy) => Promise<CommandResponse>,
  ): Promise<CommandResponse> {
    const proxy = this.proxy;
    if (proxy === null) {
      const message = `cannot ${request.kind}: bridge is not connected`;
      this.emitWire({
        dir: "in-error",
        ts: Date.now(),
        id: request.id,
        message,
      });
      this.errorHandlers.forEach((h) => h(message, request.id));
      throw new Error(message);
    }
    const sentAt = Date.now();
    this.emitWire({ dir: "out", ts: sentAt, msg: request });
    try {
      const response = await invoker(proxy);
      this.emitResponse(request, sentAt, response);
      return response;
    } catch (err) {
      // A tmux %error is tmux's reply, rejected per the TmuxBridge contract:
      // the wire logs it as the response it is, and only a bridge failure
      // reaches onError — as on the WebSocket bridge.
      if (err instanceof TmuxCommandError) {
        this.emitResponse(request, sentAt, err.response);
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.emitWire({
        dir: "in-error",
        ts: Date.now(),
        id: request.id,
        message,
      });
      this.errorHandlers.forEach((h) => h(message, request.id));
      throw err;
    }
  }

  private emitResponse(
    request: ClientToServer,
    sentAt: number,
    response: CommandResponse,
  ): void {
    const now = Date.now();
    this.emitWire({
      dir: "in-response",
      ts: now,
      id: request.id,
      response,
      latencyMs: now - sentAt,
      request,
    });
  }

  private setState(s: ConnState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateHandlers.forEach((h) => h(s));
  }

  private emitWire(entry: WireEntry): void {
    this.wireHandlers.forEach((h) => h(entry));
  }

  private allocId(): string {
    this.nextId += 1;
    return `e${this.nextId}`;
  }
}
