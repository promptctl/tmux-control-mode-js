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

import { TypedEmitter, type TmuxEventMap } from "../../emitter.js";
import type { SplitOptions } from "../../protocol/encoder.js";
import type {
  CommandResponse,
  PaneAction,
  TmuxMessage,
} from "../../protocol/types.js";
import {
  IPC,
  type InvokeRequest,
  type IpcRendererEventLike,
  type IpcRendererLike,
} from "./types.js";

/**
 * Renderer-side proxy that mirrors the public shape of `TmuxClient`.
 *
 * All methods are 1-line wrappers that send a typed `InvokeRequest` over
 * `ipcRenderer.invoke` and return the resolved `CommandResponse`. Events
 * arrive on `IPC.event` and are dispatched through an internal `TypedEmitter`
 * so `on`/`off` work identically to `TmuxClient`.
 */
export class TmuxClientProxy {
  private readonly ipc: IpcRendererLike;
  private readonly emitter: TypedEmitter;
  private readonly eventHandler: (
    event: IpcRendererEventLike,
    ...args: unknown[]
  ) => void;
  private closed = false;

  constructor(ipcRenderer: IpcRendererLike) {
    this.ipc = ipcRenderer;
    this.emitter = new TypedEmitter();

    // [LAW:dataflow-not-control-flow] Every inbound IPC event re-emits
    // unconditionally through the local emitter. The emitter's handler maps
    // decide who hears what — same as TmuxClient does with its own messages.
    this.eventHandler = (_event, ...args) => {
      this.emitter.emit(args[0] as TmuxMessage);
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

  setPaneAction(
    paneId: number,
    action: PaneAction,
  ): Promise<CommandResponse> {
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
   * Fire-and-forget detach. Matches TmuxClient.detach — no Promise.
   * The underlying IPC call is still awaited internally; any rejection is
   * intentionally dropped to preserve the void return contract.
   */
  detach(): void {
    void this.ipc
      .invoke(IPC.invoke, { method: "detach", args: [] } satisfies InvokeRequest)
      .catch(() => {
        /* fire-and-forget */
      });
  }

  /**
   * Unsubscribe this renderer from further events and stop listening locally.
   * Does NOT close the main-side TmuxClient — the main process owns that
   * lifecycle (closing a renderer shouldn't tear down tmux for other windows).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ipc.removeListener(
      IPC.event,
      this.eventHandler as (...args: unknown[]) => void,
    );
    this.ipc.send(IPC.unregister);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async invoke(req: InvokeRequest): Promise<CommandResponse> {
    return (await this.ipc.invoke(IPC.invoke, req)) as CommandResponse;
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
): TmuxClientProxy {
  return new TmuxClientProxy(ipcRenderer);
}

// Re-export the types a renderer consumer might need without a second import.
export type {
  IpcRendererLike,
  IpcRendererEventLike,
} from "./types.js";
