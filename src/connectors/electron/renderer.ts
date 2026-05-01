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

import { TypedEmitter, type TmuxEventMap } from "../../emitter.js";
import { TmuxCommandError } from "../../errors.js";
import {
  asPaneOutput,
  type CommandResponse,
  type PaneAction,
  type TmuxMessage,
} from "../../protocol/types.js";
import type { RpcProxyApi } from "../rpc.js";
import {
  BridgeError,
  DEFAULT_ACK_BATCH_BYTES,
  IPC,
  type AckMessage,
  type InvokeRequest,
  type IpcRendererLike,
  type IpcRendererOnListener,
  type RendererBridgeOptions,
} from "./types.js";

// Wire envelope returned by the main-side invoke handler. See main.ts —
// `dispatchRpcRequest`'s success/TmuxCommandError outcomes get encoded as a
// plain `{ok, response}` object so the structured CommandResponse survives
// IPC serialization. The renderer re-throws TmuxCommandError so consumers
// see the same exception shape they would get from a local TmuxClient.
type InvokeResultEnvelope =
  | { readonly ok: true; readonly response: CommandResponse }
  | { readonly ok: false; readonly response: CommandResponse };

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
export class TmuxClientProxy implements RpcProxyApi {
  private readonly ipc: IpcRendererLike;
  private readonly emitter: TypedEmitter;
  private readonly eventHandler: IpcRendererOnListener;
  private readonly ackBatchBytes: number;
  /**
   * Positive value enables the per-call timeout in `invoke`. 0 means disabled
   * (the default). The renderer-side promise rejects with `BridgeError("TIMEOUT")`
   * if the underlying `ipcRenderer.invoke` does not settle in time; the
   * underlying main-side dispatch is NOT cancelled — it will resolve in order
   * against the TmuxClient FIFO and its result is discarded by the renderer.
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
      const msg = args[0] as TmuxMessage;
      this.account(msg);
      this.emitter.emit(msg);
    };
    this.ipc.on(IPC.event, this.eventHandler);

    // Register this renderer as an event subscriber. Fire-and-forget.
    this.ipc.send(IPC.register);
  }

  // ---------------------------------------------------------------------------
  // Event delegation — same overload set as TmuxClient.
  // ---------------------------------------------------------------------------

  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(event: "*", handler: (ev: TmuxMessage) => void): void;
  on(event: string, handler: (ev: never) => void): void {
    this.emitter.on(event as "*", handler as (ev: TmuxMessage) => void);
  }

  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(event: "*", handler: (ev: TmuxMessage) => void): void;
  off(event: string, handler: (ev: never) => void): void {
    this.emitter.off(event as "*", handler as (ev: TmuxMessage) => void);
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

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    return this.invoke({ method: "sendKeys", args: [target, keys] });
  }

  setSize(width: number, height: number): Promise<CommandResponse> {
    return this.invoke({ method: "setSize", args: [width, height] });
  }

  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse> {
    return this.invoke({ method: "setPaneAction", args: [paneId, action] });
  }

  subscribe(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    return this.invoke({ method: "subscribe", args: [name, what, format] });
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
    if (!result.ok) throw new TmuxCommandError(result.response);
    return result.response;
  }

  private withTimeout<T>(p: Promise<T>, method: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new BridgeError(
            "TIMEOUT",
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

// Re-export the types a renderer consumer might need without a second import.
export type {
  IpcRendererLike,
  IpcRendererEventLike,
  RendererBridgeOptions,
} from "./types.js";
