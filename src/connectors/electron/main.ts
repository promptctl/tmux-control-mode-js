// src/connectors/electron/main.ts
// Electron main-process bridge: forwards TmuxClient events to registered
// renderers and routes renderer command invocations to the client.

// [LAW:single-enforcer] Exactly one `handle("tmux:invoke", ...)` handler; all
// renderer method calls funnel through it. Mirrors client.ts's single
// correlation site.
// [LAW:one-source-of-truth] IPC channel names + request shape imported from
// ./types.js — no duplicate string literals on this side.

import type { TmuxClient } from "../../client.js";
import type {
  CommandResponse,
  TmuxMessage,
} from "../../protocol/types.js";
import {
  IPC,
  type IpcMainLike,
  type IpcMainEventLike,
  type InvokeRequest,
  type MainBridgeHandle,
  type WebContentsLike,
} from "./types.js";

// ---------------------------------------------------------------------------
// Method dispatch table.
//
// [LAW:dataflow-not-control-flow] One table, one indexed lookup. Adding a
// method to TmuxClient means adding one entry here — no new control-flow
// branch on the invoke handler.
// [LAW:one-type-per-behavior] A single `Dispatcher` type covers every
// TmuxClient method; `satisfies` below makes the compiler check exhaustiveness.
// ---------------------------------------------------------------------------

type Dispatcher = {
  readonly [R in InvokeRequest as R["method"]]: (
    client: TmuxClient,
    args: R["args"],
  ) => Promise<CommandResponse> | CommandResponse | undefined;
};

const DISPATCH: Dispatcher = {
  execute: (c, [command]) => c.execute(command),
  listWindows: (c) => c.listWindows(),
  listPanes: (c) => c.listPanes(),
  sendKeys: (c, [target, keys]) => c.sendKeys(target, keys),
  splitWindow: (c, [options]) => c.splitWindow(options),
  setSize: (c, [width, height]) => c.setSize(width, height),
  setPaneAction: (c, [paneId, action]) => c.setPaneAction(paneId, action),
  subscribe: (c, [name, what, format]) => c.subscribe(name, what, format),
  unsubscribe: (c, [name]) => c.unsubscribe(name),
  setFlags: (c, [flags]) => c.setFlags(flags),
  clearFlags: (c, [flags]) => c.clearFlags(flags),
  requestReport: (c, [paneId, report]) => c.requestReport(paneId, report),
  queryClipboard: (c) => c.queryClipboard(),
  detach: (c) => {
    c.detach();
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// createMainBridge
// ---------------------------------------------------------------------------

/**
 * Bridge a TmuxClient into Electron's IPC system.
 *
 * - Forwards every event `client` emits to every registered renderer via
 *   `webContents.send(IPC.event, msg)`. `Uint8Array` payloads ride Electron's
 *   native structured-clone IPC — no base64 hop needed.
 * - Installs `ipcMain.handle(IPC.invoke, ...)` to route renderer method calls
 *   to the corresponding `TmuxClient` method.
 * - Tracks subscribers via `tmux:register` / `tmux:unregister` and cleans up
 *   automatically when a renderer's WebContents is destroyed.
 *
 * Returns a handle whose `dispose()` removes every installed IPC handler and
 * clears the subscriber set. The caller still owns `client.close()`.
 */
export function createMainBridge(
  client: TmuxClient,
  ipcMain: IpcMainLike,
): MainBridgeHandle {
  const subscribers = new Set<WebContentsLike>();

  // [LAW:dataflow-not-control-flow] One send per subscriber, every message,
  // unconditionally. The set being empty means zero iterations — data decides.
  const forward = (msg: TmuxMessage): void => {
    for (const wc of subscribers) {
      // [LAW:no-defensive-null-guards] isDestroyed is a trust-boundary check:
      // Electron may fire "destroyed" asynchronously, so a send could race a
      // teardown. Guarding here avoids a native crash inside wc.send.
      if (wc.isDestroyed()) {
        subscribers.delete(wc);
        continue;
      }
      wc.send(IPC.event, msg);
    }
  };

  client.on("*", forward);

  const onRegister = (event: IpcMainEventLike): void => {
    const wc = event.sender;
    if (subscribers.has(wc)) return;
    subscribers.add(wc);
    wc.once("destroyed", () => {
      subscribers.delete(wc);
    });
  };

  const onUnregister = (event: IpcMainEventLike): void => {
    subscribers.delete(event.sender);
  };

  ipcMain.on(IPC.register, onRegister as (...args: unknown[]) => void);
  ipcMain.on(IPC.unregister, onUnregister as (...args: unknown[]) => void);

  // [LAW:single-enforcer] Single invoke handler; DISPATCH table resolves the
  // method. No switch, no per-method handle() registration.
  ipcMain.handle(IPC.invoke, async (_event, ...args) => {
    const req = args[0] as InvokeRequest;
    const fn = DISPATCH[req.method] as (
      c: TmuxClient,
      a: InvokeRequest["args"],
    ) => Promise<CommandResponse> | CommandResponse | undefined;
    const result = await fn(client, req.args);
    return result ?? undefined;
  });

  return {
    dispose() {
      client.off("*", forward);
      ipcMain.removeListener(
        IPC.register,
        onRegister as (...args: unknown[]) => void,
      );
      ipcMain.removeListener(
        IPC.unregister,
        onUnregister as (...args: unknown[]) => void,
      );
      ipcMain.removeHandler(IPC.invoke);
      subscribers.clear();
    },
  };
}

// Re-export the types a main-process consumer might need without forcing a
// second import site.
export type {
  IpcMainLike,
  MainBridgeHandle,
  WebContentsLike,
} from "./types.js";
