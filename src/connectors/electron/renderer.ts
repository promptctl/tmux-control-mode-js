// src/connectors/electron/renderer.ts
// Electron renderer-process bridge: exposes a TmuxClient-shaped proxy that
// forwards method calls and receives events via ipcRenderer.
//
// This module is PURE — no Node-only imports. Safe under contextIsolation
// and sandbox. The renderer's preload (or exposed contextBridge) provides
// `ipcRenderer` as a parameter; we never import 'electron' directly.

// [LAW:one-source-of-truth] TmuxEventMap and TypedEmitter are reused from
// src/emitter.ts so the proxy's event API cannot drift from TmuxClient's.
// Adding an event on the main side surfaces it on the proxy automatically.
//
// [LAW:one-source-of-truth] The bridged-method surface comes from the
// `RpcProxyApi` mapped type in ../rpc.ts (which is itself derived from the
// `RpcRequest` discriminated union). `class TmuxClientProxy implements
// RpcProxyApi` makes drift between the renderer surface and the wire
// protocol a compile error.

import type { ConnectionState } from "../../connection-state.js";
import {
  TypedEmitter,
  type EmitterMessage,
  type TmuxEventMap,
} from "../../emitter.js";
import { TmuxCommandError } from "../../errors.js";
import { type AttachOptions, type BytesSink } from "../../pane-output.js";
import type { SplitOptions } from "../../protocol/encoder.js";
import {
  isPaneOutput,
  type CommandResponse,
  type PaneAction,
  type PaneOutputMessage,
  type TmuxMessage,
} from "../../protocol/types.js";
import { TopologyRouter } from "../../topology-router.js";
import type { RpcProxyApi } from "../rpc.js";
import type { TmuxConnection } from "../../client.js";
import {
  BridgeError,
  DEFAULT_ACK_BATCH_BYTES,
  IPC,
  type AckMessage,
  type InvokeRequest,
  type InvokeResultEnvelope,
  type IpcRendererLike,
  type IpcRendererOnListener,
  type RendererBridgeOptions,
} from "./types.js";

// Wire envelope returned by the main-side invoke handler.
//
// [LAW:one-source-of-truth] `InvokeResultEnvelope` is defined in `./types.ts`
// (renderer-safe, shared between main.ts and renderer.ts) — there is exactly
// one declaration of this shape in the codebase. The renderer dispatches on
// `status` and reconstructs typed exceptions:
//   - `ok`            → resolve with response
//   - `tmux-error`    → throw TmuxCommandError(response)
//   - `bridge-error`  → throw BridgeError.fromPayload(error)
//
// Bridge-level failures ride a `BridgeErrorPayload` (not a raw Error) so
// `.code` survives Electron's structured-clone IPC serializer, which would
// otherwise drop subclass properties.

/**
 * Renderer-side proxy that mirrors the public shape of `TmuxClient`.
 *
 * All methods are 1-line wrappers that send a typed `InvokeRequest` over
 * `ipcRenderer.invoke` and return the resolved `CommandResponse`. Events
 * arrive on `IPC.event` and are dispatched through an internal `TypedEmitter`
 * so `on`/`off` work identically to `TmuxClient`.
 *
 * Backpressure: the proxy counts bytes received from `%output` /
 * `%extended-output` messages and replies with `tmux:ack` once the
 * per-pane unacknowledged total crosses `ackBatchBytes`. This is the credit
 * signal the main bridge uses to decide when to resume a paused pane. A
 * renderer that never drains its event queue (e.g. blocked on heavy DOM
 * work) will starve itself of new output — the same shape as tmux's own
 * `%pause`-when-the-client-falls-behind contract.
 */
export class TmuxClientProxy implements RpcProxyApi, TmuxConnection {
  private readonly ipc: IpcRendererLike;
  private readonly emitter: TypedEmitter;
  // [LAW:one-source-of-truth] TopologyRouter is the shared substrate for byte
  //   routing. It owns the topology table, sink registry, and epoch tracker so
  //   none of them are duplicated here.
  private readonly router = new TopologyRouter();
  private readonly eventHandler: IpcRendererOnListener;
  private readonly ackBatchBytes: number;
  /**
   * Positive value enables the per-call timeout in `invoke`. 0 means disabled
   * (the default). The renderer-side promise rejects with
   * `BridgeError("BRIDGE_TIMEOUT")` if the underlying `ipcRenderer.invoke`
   * does not settle in time; the underlying main-side dispatch is NOT
   * cancelled — it will resolve in order against the TmuxClient FIFO and its
   * result is discarded by the renderer.
   */
  private readonly invokeTimeoutMs: number;
  // Per-pane bytes received but not yet acknowledged. The byte count is
  // strictly the wire size of the data payload — which is exactly what main
  // accounted on the way out, so the credit math stays balanced.
  private readonly pendingAck = new Map<number, number>();
  // [LAW:single-enforcer] One teardown per proxy: `closed` gates `close()`
  // so a second invocation is a true noop (no duplicate IPC.unregister send,
  // no double removeListener). The host renderer-side decision is "tear down
  // exactly once per proxy"; this flag is the single place that's enforced.
  private closed = false;
  // [LAW:one-source-of-truth] Mirrors the main-process client's lifecycle.
  // The proxy starts in `connecting` and updates whenever a connection-state
  // event arrives from main; once `close()` is called, the proxy reports
  // `closed{disposed}` regardless of what main last broadcast.
  private currentConnectionState: ConnectionState = { status: "connecting" };

  constructor(
    ipcRenderer: IpcRendererLike,
    options: RendererBridgeOptions = {},
  ) {
    this.ipc = ipcRenderer;
    this.emitter = new TypedEmitter();
    this.ackBatchBytes = options.ackBatchBytes ?? DEFAULT_ACK_BATCH_BYTES;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 0;

    // [LAW:single-enforcer] Pane bytes flow exclusively through the sink
    //   registry; state events flow through the emitter. The IPC.event wire
    //   format carries both — main sends state via `client.on('*', forward)`
    //   and bytes via `client.attachBytesSink(sink)` — and the
    //   renderer narrows here. The local emitter's type surface still
    //   excludes `PaneOutputMessage`, so `this.emitter.emit(msg)` is a
    //   compile error for byte messages, which is what enforces the split
    //   on the renderer side.
    this.eventHandler = (_event, ...args) => {
      // [LAW:locality-or-seam] IPC wire format is the boundary type; widen
      //   to admit byte messages here, narrow into the two channels below.
      //   The local `EmitterMessage` does not include `PaneOutputMessage`,
      //   so the `else` branch below carries an `EmitterMessage` correctly.
      const msg = args[0] as EmitterMessage | PaneOutputMessage;
      if (isPaneOutput(msg)) {
        this.account(msg);
        // [LAW:single-enforcer] Byte dispatch routes through the router.
        this.router.dispatchBytes({ paneId: msg.paneId, data: msg.data });
        return;
      }
      // [LAW:no-ambient-temporal-coupling] connection-state drives the router
      //   lifecycle. onTransportReady wires the execute callback;
      //   onTransportClose tears down all attached sinks.
      if (msg.type === "connection-state") {
        this.currentConnectionState = msg.state;
        if (msg.state.status === "ready") {
          this.router.onTransportReady((cmd) => this.execute(cmd));
        } else if (msg.state.status === "closed") {
          this.router.onTransportClose();
        }
      } else {
        // [LAW:single-enforcer] All topology mutations route through the router.
        this.router.handleNotification(msg as TmuxMessage);
      }
      this.emitter.emit(msg);
    };
    this.ipc.on(IPC.event, this.eventHandler);

    // Register this renderer as an event subscriber. Fire-and-forget.
    this.ipc.send(IPC.register);
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  get connectionState(): ConnectionState {
    return this.currentConnectionState;
  }

  // ---------------------------------------------------------------------------
  // Event delegation — same overload set as TmuxClient.
  //
  // `TmuxEventMap` does not contain `'output'` or `'extended-output'`;
  // pane bytes flow through `attachBytesSink` only.
  // ---------------------------------------------------------------------------

  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(event: "*", handler: (ev: EmitterMessage) => void): void;
  on(event: string, handler: (ev: never) => void): void {
    this.emitter.on(event as "*", handler as (ev: EmitterMessage) => void);
  }

  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(event: "*", handler: (ev: EmitterMessage) => void): void;
  off(event: string, handler: (ev: never) => void): void {
    this.emitter.off(event as "*", handler as (ev: EmitterMessage) => void);
  }

  // ---------------------------------------------------------------------------
  // Command methods — mirror TmuxClient 1:1. Each call sends one InvokeRequest.
  //
  // [LAW:dataflow-not-control-flow] Every method performs the same operation
  // (build InvokeRequest, call ipc.invoke). Variance lives in the request
  // payload, not in control flow.
  // ---------------------------------------------------------------------------

  execute(command: string): Promise<CommandResponse> {
    return this.invoke({ method: "execute", args: [command] });
  }

  listWindows(): Promise<CommandResponse> {
    return this.invoke({ method: "listWindows", args: [] });
  }

  listPanes(): Promise<CommandResponse> {
    return this.invoke({ method: "listPanes", args: [] });
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    return this.invoke({ method: "sendKeys", args: [target, keys] });
  }

  splitWindow(options?: SplitOptions): Promise<CommandResponse> {
    return this.invoke({ method: "splitWindow", args: [options] });
  }

  setSize(width: number, height: number): Promise<CommandResponse> {
    return this.invoke({ method: "setSize", args: [width, height] });
  }

  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse> {
    return this.invoke({ method: "setPaneAction", args: [paneId, action] });
  }

  subscribeRaw(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    return this.invoke({ method: "subscribeRaw", args: [name, what, format] });
  }

  unsubscribe(name: string): Promise<CommandResponse> {
    return this.invoke({ method: "unsubscribe", args: [name] });
  }

  setFlags(flags: readonly string[]): Promise<CommandResponse> {
    return this.invoke({ method: "setFlags", args: [flags] });
  }

  clearFlags(flags: readonly string[]): Promise<CommandResponse> {
    return this.invoke({ method: "clearFlags", args: [flags] });
  }

  requestReport(paneId: number, report: string): Promise<CommandResponse> {
    return this.invoke({ method: "requestReport", args: [paneId, report] });
  }

  queryClipboard(): Promise<CommandResponse> {
    return this.invoke({ method: "queryClipboard", args: [] });
  }

  // [LAW:single-enforcer] Byte sink registration delegates to the router,
  //   which owns the SinkRegistry, bootstrap trigger, and topology table.
  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void {
    return this.router.attachBytesSink(sink, options);
  }

  /**
   * Unsubscribe this renderer from further events and stop listening locally.
   * Does NOT close the main-side TmuxClient — the main process owns that
   * lifecycle (closing a renderer shouldn't tear down tmux for other windows).
   *
   * `detach()` is intentionally NOT exposed on the proxy: it tears down the
   * tmux connection for every renderer that shares the bridge, which is an
   * admin operation the host application owns. Renderers that need to walk
   * away can `close()` to drop their subscription; the main process is the
   * single party that may invoke `client.detach()` or `client.close()`.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ipc.removeListener(IPC.event, this.eventHandler);
    this.ipc.send(IPC.unregister);
    this.pendingAck.clear();
    this.router.onTransportClose();
    // The proxy's lifecycle is over even though main keeps running. Report
    // `closed{disposed}` so consumers know this proxy will not emit again
    // (and emit a final synthetic event so registered listeners observe it).
    // [LAW:one-source-of-truth] close() is the proxy-side terminator: even if
    // main already broadcast closed{exit|transport-error}, the proxy reports
    // closed{disposed} so the proxy's lifecycle reflects *its* termination
    // cause, not main's. The only suppression is when we already reported
    // closed{disposed} (idempotent close()).
    const alreadyDisposed =
      this.currentConnectionState.status === "closed" &&
      this.currentConnectionState.reason === "disposed";
    if (!alreadyDisposed) {
      this.currentConnectionState = { status: "closed", reason: "disposed" };
      this.emitter.emit({
        type: "connection-state",
        state: this.currentConnectionState,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async invoke(req: InvokeRequest): Promise<CommandResponse> {
    // [LAW:dataflow-not-control-flow] Both the timeout and no-timeout cases
    // run the same shape — `await` a single Promise to a settled envelope.
    // The variability lives in which Promise is awaited, not in whether the
    // await happens. The timeout branch races the IPC call against a timer;
    // when timeout is disabled (the default), the IPC promise is awaited
    // directly with no timer overhead.
    const ipcPromise = this.ipc.invoke(IPC.invoke, req);
    const settled =
      this.invokeTimeoutMs > 0
        ? await this.withTimeout(ipcPromise, req.method)
        : await ipcPromise;
    const result = settled as InvokeResultEnvelope;
    if (result.status === "ok") return result.response;
    if (result.status === "tmux-error") {
      throw new TmuxCommandError(result.response);
    }
    // [LAW:single-enforcer] BridgeError reconstruction lives at this seam
    // only — `BridgeError.fromPayload` is the single way a renderer-side
    // typed error is rebuilt from a wire payload. Real Electron's
    // structured-clone serializer drops `.code` on Error subclasses, so the
    // payload pair is what keeps the error machine-distinguishable.
    throw BridgeError.fromPayload(result.error);
  }

  private withTimeout<T>(p: Promise<T>, method: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new BridgeError(
            "BRIDGE_TIMEOUT",
            `proxy.${method} did not settle within ${this.invokeTimeoutMs}ms`,
          ),
        );
      }, this.invokeTimeoutMs);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e as Error);
        },
      );
    });
  }

  // [LAW:single-enforcer] Called from the byte-only branch of `eventHandler`,
  // so `msg` is statically `PaneOutputMessage`. The accounting pipeline is
  // the same for both `output` and `extended-output` — main credits them
  // identically on the way out, so we mirror that on the way in.
  private account(msg: PaneOutputMessage): void {
    const next = (this.pendingAck.get(msg.paneId) ?? 0) + msg.data.byteLength;
    if (next < this.ackBatchBytes) {
      this.pendingAck.set(msg.paneId, next);
      return;
    }
    this.pendingAck.delete(msg.paneId);
    const ack: AckMessage = { paneId: msg.paneId, bytes: next };
    this.ipc.send(IPC.ack, ack);
  }
}

/**
 * Create a renderer-side proxy for a `TmuxClient` running in the main process.
 *
 * The returned object has the same public shape as `TmuxClient` but proxies
 * all calls over Electron IPC. Safe under `contextIsolation: true` and
 * `sandbox: true` — the caller supplies `ipcRenderer` (typically via a
 * preload-script contextBridge exposure).
 */
export function createRendererBridge(
  ipcRenderer: IpcRendererLike,
  options?: RendererBridgeOptions,
): TmuxClientProxy {
  return new TmuxClientProxy(ipcRenderer, options);
}

// Re-export the types a renderer consumer might need without a second import.
export type {
  IpcRendererLike,
  IpcRendererEventLike,
  RendererBridgeOptions,
} from "./types.js";
