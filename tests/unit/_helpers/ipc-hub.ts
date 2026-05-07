// tests/unit/_helpers/ipc-hub.ts
// In-memory IPC hub that couples a fake IpcMain with one or more fake
// IpcRenderers. Mirrors real Electron semantics:
//   - structuredClone on every cross-process arg (regressions that depend on
//     shared identity fail here the same way they'd fail in production).
//   - ipcMain.handle throws on a second registration for the same channel.
//   - destroyed-listeners are removable.
//
// Used by tests that need to drive the Electron bridges (main + renderer)
// without booting a real Electron process.

import type {
  IpcMainEventLike,
  IpcMainInvokeEventLike,
  IpcMainLike,
  IpcRendererLike,
  WebContentsLike,
} from "../../../src/connectors/electron/types.js";

export interface FakeRenderer {
  readonly ipcRenderer: IpcRendererLike;
  readonly sender: WebContentsLike;
  destroy(): void;
  /**
   * Visibility hook for leak regression tests: how many `destroyed`
   * listeners are still attached to this fake's WebContents.
   */
  destroyHandlerCount(): number;
}

export interface IpcHub {
  readonly ipcMain: IpcMainLike;
  createRenderer(): FakeRenderer;
}

export function createIpcHub(): IpcHub {
  type InvokeHandler = (
    event: IpcMainInvokeEventLike,
    ...args: unknown[]
  ) => unknown | Promise<unknown>;
  type OnHandler = (event: IpcMainEventLike, ...args: unknown[]) => void;

  const invokeHandlers = new Map<string, InvokeHandler>();
  const mainOnListeners = new Map<string, Set<OnHandler>>();

  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      // Real Electron throws on second handler registration. The fake
      // mirrors that contract so unit tests fail loudly when a regression
      // re-introduces the per-window registration bug.
      if (invokeHandlers.has(channel)) {
        throw new Error(
          `Attempted to register a second handler for '${channel}'`,
        );
      }
      invokeHandlers.set(channel, listener);
    },
    removeHandler(channel) {
      invokeHandlers.delete(channel);
    },
    on(channel, listener) {
      let set = mainOnListeners.get(channel);
      if (!set) {
        set = new Set();
        mainOnListeners.set(channel, set);
      }
      set.add(listener as OnHandler);
    },
    removeListener(channel, listener) {
      mainOnListeners.get(channel)?.delete(listener as OnHandler);
    },
  };

  function createRenderer(): FakeRenderer {
    type RendererHandler = (event: unknown, ...args: unknown[]) => void;
    const rendererListeners = new Map<string, Set<RendererHandler>>();
    let destroyed = false;
    const destroyHandlers = new Set<() => void>();

    const sender: WebContentsLike = {
      send(channel, ...args) {
        if (destroyed) return;
        const set = rendererListeners.get(channel);
        if (!set) return;
        // Real Electron sends args through structuredClone before they
        // reach the renderer. Mirroring that here means a test that mutates
        // the source object after dispatch (or relies on by-ref identity)
        // fails the same way it would in production.
        for (const h of set) h({}, ...cloneArgs(args));
      },
      once(event, listener) {
        if (event === "destroyed") destroyHandlers.add(listener);
      },
      removeListener(event, listener) {
        if (event === "destroyed") destroyHandlers.delete(listener);
      },
      isDestroyed() {
        return destroyed;
      },
    };

    const ipcRenderer: IpcRendererLike = {
      async invoke(channel, ...args) {
        const handler = invokeHandlers.get(channel);
        if (handler === undefined) {
          throw new Error(`no handler registered for ${channel}`);
        }
        const result = await handler({ sender }, ...cloneArgs(args));
        return cloneArgs([result])[0];
      },
      send(channel, ...args) {
        const set = mainOnListeners.get(channel);
        if (!set) return;
        for (const h of set) h({ sender }, ...cloneArgs(args));
      },
      on(channel, listener) {
        let set = rendererListeners.get(channel);
        if (!set) {
          set = new Set();
          rendererListeners.set(channel, set);
        }
        set.add(listener as RendererHandler);
      },
      removeListener(channel, listener) {
        rendererListeners.get(channel)?.delete(listener as RendererHandler);
      },
    };

    return {
      ipcRenderer,
      sender,
      destroy() {
        destroyed = true;
        const snapshot = [...destroyHandlers];
        destroyHandlers.clear();
        for (const h of snapshot) h();
      },
      destroyHandlerCount: () => destroyHandlers.size,
    };
  }

  return { ipcMain, createRenderer };
}

export function cloneArgs(args: readonly unknown[]): unknown[] {
  return args.map((a) => structuredClone(a));
}
