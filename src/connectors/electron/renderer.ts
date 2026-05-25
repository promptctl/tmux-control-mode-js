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
  isTmuxMessage,
  type EmitterMessage,
  type TmuxEventMap,
} from "../../emitter.js";
import { TmuxCommandError } from "../../errors.js";
import {
  attachPaneSinkViaEmitter,
  type PaneByteSink,
} from "../../pane-sink.js";
import type { SplitOptions } from "../../protocol/encoder.js";
import {
  asPaneOutput,
  type CommandResponse,
  type PaneAction,
  type TmuxMessage,
} from "../../protocol/types.js";
import type { RpcProxyApi } from "../rpc.js";
import type { TmuxClientLike } from "../../client.js";
import {
  BridgeError,
  DEFAULT_ACK_BATCH_BYTES,
  IPC,
  type AckMessage,
  type InvokeRequest,
  type InvokeResultEnvelope,
  type IpcRendererLike,
  type IpcRendererOnListener,
  type PaneBytesEnvelope,
  type PaneEndEnvelope,
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
export class TmuxClientProxy implements RpcProxyApi, TmuxClientLike {
  private readonly ipc: IpcRendererLike;
  private readonly emitter: TypedEmitter;
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

    // [LAW:dataflow-not-control-flow] Every inbound IPC event re-emits
    // unconditionally through the local emitter. The emitter's handler maps
    // decide who hears what — same as TmuxClient does with its own messages.
    // Output messages additionally feed the credit accumulator; non-output
    // messages contribute zero, so the same path runs for all.
    this.eventHandler = (_event, ...args) => {
      const msg = args[0] as EmitterMessage;
      // [LAW:dataflow-not-control-flow] connection-state messages flow through
      // the same channel; they're picked up here before re-emission so the
      // proxy's `connectionState` getter is in sync with whatever fires.
      if (msg.type === "connection-state") {
        this.currentConnectionState = msg.state;
      }
      // account() requires a parsed TmuxMessage; non-tmux events have no
      // pane bytes and contribute nothing to the credit accumulator.
      // [LAW:single-enforcer] discriminator lives in src/emitter.ts.
      if (isTmuxMessage(msg)) {
        this.account(msg);
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

  // [LAW:locality-or-seam] The proxy receives parsed `output` /
  //   `extended-output` events from main over IPC; its emitter is the
  //   byte fan-out point. `attachPaneSinkViaEmitter` is the canonical adapter
  //   from that emitter onto the `PaneByteSink` seam — the same one used by
  //   every other bridge-shaped client (WebSocketTmuxClient,
  //   BridgePaneStreamClient, FakeTmuxClient).
  // [LAW:single-enforcer] One implementation across all emitter-backed
  //   clients — the proxy does not maintain a parallel paneSink registry.
  //
  // Note: this routes through the proxy's per-event emitter, not through the
  // `createPaneBytesReceiver` (paneBytes IPC channel) path. The latter is
  // driven by a main-side `attachWebContentsSink` call and is a separate
  // opt-in optimization that bypasses the regular event channel; it is the
  // renderer-side counterpart of `WebContentsSink`, not of `attachPaneSink`.
  attachPaneSink(paneId: number, sink: PaneByteSink): () => void {
    return attachPaneSinkViaEmitter(this, paneId, sink);
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

  // [LAW:single-enforcer] Discriminator lives in asPaneOutput
  // (src/protocol/types.ts). Once we have the typed receipt, the accounting
  // pipeline is the same for both output and extended-output — main credits
  // them identically on the way out, so we mirror that on the way in.
  private account(msg: TmuxMessage): void {
    const out = asPaneOutput(msg);
    if (out === null) return;
    const next = (this.pendingAck.get(out.paneId) ?? 0) + out.data.byteLength;
    if (next < this.ackBatchBytes) {
      this.pendingAck.set(out.paneId, next);
      return;
    }
    this.pendingAck.delete(out.paneId);
    const ack: AckMessage = { paneId: out.paneId, bytes: next };
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

// ---------------------------------------------------------------------------
// Renderer-side companion to `attachWebContentsSink` (main.ts).
//
// Subscribes to `IPC.paneBytes` + `IPC.paneEnd`, filters by paneId, and
// forwards each chunk into a caller-supplied `PaneByteSink`. The seam type
// is identical on both sides of the IPC hop: bytes leave the main-side sink,
// cross structured-clone IPC, and land in the renderer-side sink — at no
// point does the consumer hold a raw `Uint8Array` as a value the type system
// would let them decode the wrong way.
//
// [LAW:single-enforcer] One Electron byte-receiver lives here only. Hosts
// stop writing `ipcRenderer.on('pane-bytes', ...)` ad hoc and stop choosing
// channel names or envelope shapes.
// [LAW:locality-or-seam] The seam shape is `PaneByteSink`. Renderer consumers
// compose a sink (an xterm.js feeder, `createTextStreamSink(...)`, or any
// other implementation) and hand it in — the receiver is a wire-to-sink
// adapter, nothing more.
// [LAW:dataflow-not-control-flow] Every inbound frame runs the same path
// (filter → sink call). The auto-detach on `paneEnd` is data flow on the
// attachment-terminated state, not a control-flow guard.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Active-receiver registry — exactly one receiver per
// `(ipcRenderer, paneId)` pair.
//
// Symmetric to the main-side `ACTIVE_PANE_SINK_ATTACHMENTS` in `main.ts`,
// for the same reason: `paneEnd` carries only `paneId`, so a second
// receiver for the same pair would either race the auto-detach (the
// first to handle `paneEnd` tears every receiver down) or split the byte
// stream across two sinks with no way to distinguish them. The
// constructor refuses loudly.
//
// [LAW:single-enforcer] One constructor-time check, one registry, one API.
// [LAW:no-shared-mutable-globals] WeakMap keyed by `ipcRenderer` so a
// torn-down preload's slot is GC-eligible alongside it.
// ---------------------------------------------------------------------------

const ACTIVE_PANE_BYTES_RECEIVERS = new WeakMap<IpcRendererLike, Set<number>>();

/**
 * Subscribe to the pane-byte stream emitted by a main-side
 * `WebContentsSink` and forward each chunk into `sink`.
 *
 * Listens on `IPC.paneBytes` and `IPC.paneEnd`, filters every inbound
 * envelope by `paneId`, and calls `sink.write(bytes)` / `sink.end?.()` for
 * matching frames. `Uint8Array` payloads survive Electron's structured
 * clone — the receiver does not copy.
 *
 * ## Exclusivity (one receiver per `(ipcRenderer, paneId)`)
 *
 * The wire envelope is `paneId`-scoped — there is no stream identifier.
 * A second `createPaneBytesReceiver` for a pair that already has an
 * active receiver throws
 * `BridgeError("BRIDGE_PANE_SINK_ALREADY_ATTACHED")` rather than letting
 * a future `paneEnd` race the auto-detach across two receivers. The slot
 * is freed when the receiver detaches (either auto-detach on `paneEnd`
 * or the caller's disposer). Renderers that want to "rotate" the sink
 * for a pane MUST call the prior disposer first.
 *
 * ## Lifecycle
 *
 * - `paneEnd` for the matching `paneId` calls `sink.end?.()` and **auto-
 *   detaches** both IPC listeners. After that, no further frames will
 *   reach this `sink` even if main keeps sending; the disposer returned
 *   to the caller is idempotent and safe to call afterwards.
 * - The returned disposer detaches both listeners explicitly. It does
 *   NOT call `sink.end?.()` — the disposer is the renderer's "I don't
 *   want this anymore" signal, not a stream-terminated signal. Sinks
 *   that need to flush on local teardown should call their own `end()`
 *   from the caller's side.
 *
 * ## Sink contract
 *
 * `sink.write` runs synchronously inside the IPC event handler and MUST
 * NOT throw — same constraint as the underlying `PaneByteSink` contract
 * on main. A throwing sink propagates through the IPC dispatch loop with
 * unpredictable cleanup semantics; wrap risky work in try/catch inside
 * the sink itself.
 *
 * @see PaneByteSink for the sink contract.
 * @see attachWebContentsSink (main.ts) for the main-side producer.
 */
export function createPaneBytesReceiver(
  ipcRenderer: IpcRendererLike,
  paneId: number,
  sink: PaneByteSink,
): () => void {
  let active = ACTIVE_PANE_BYTES_RECEIVERS.get(ipcRenderer);
  if (active === undefined) {
    active = new Set<number>();
    ACTIVE_PANE_BYTES_RECEIVERS.set(ipcRenderer, active);
  }
  if (active.has(paneId)) {
    throw new BridgeError(
      "BRIDGE_PANE_SINK_ALREADY_ATTACHED",
      `PaneBytesReceiver already attached for paneId=${paneId} on this ipcRenderer; dispose the prior attachment before constructing a new one`,
    );
  }
  active.add(paneId);
  const registrySet = active;

  let detached = false;

  const detach = (): void => {
    if (detached) return;
    detached = true;
    registrySet.delete(paneId);
    ipcRenderer.removeListener(IPC.paneBytes, onBytes);
    ipcRenderer.removeListener(IPC.paneEnd, onEnd);
  };

  const onBytes: IpcRendererOnListener = (_event, ...args) => {
    const envelope = args[0] as PaneBytesEnvelope;
    if (envelope.paneId !== paneId) return;
    sink.write(envelope.data);
  };

  const onEnd: IpcRendererOnListener = (_event, ...args) => {
    const envelope = args[0] as PaneEndEnvelope;
    if (envelope.paneId !== paneId) return;
    // [LAW:dataflow-not-control-flow] `end` is a terminal signal: the
    // attachment is over. Detach first so a sink whose `end()` throws or
    // re-enters cannot fire `write` again from this receiver.
    detach();
    sink.end?.();
  };

  ipcRenderer.on(IPC.paneBytes, onBytes);
  ipcRenderer.on(IPC.paneEnd, onEnd);

  return detach;
}

// Re-export the types a renderer consumer might need without a second import.
export type {
  IpcRendererLike,
  IpcRendererEventLike,
  PaneBytesEnvelope,
  PaneEndEnvelope,
  RendererBridgeOptions,
} from "./types.js";
