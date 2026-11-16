// tests/unit/_helpers/ipc-hub.ts
// In-memory IPC hub that couples a fake IpcMain with one or more fake
// WebContents, each showing one page (document) at a time. Mirrors real
// Electron semantics:
//   - structuredClone on every cross-process arg (regressions that depend on
//     shared identity fail here the same way they'd fail in production).
//   - ipcMain.handle throws on a second registration for the same channel.
//   - page listeners (destroyed / did-navigate / render-process-gone /
//     did-fail-load) are removable.
//   - every IPC event carries the sending document's frame-host ids, and a
//     WebContents' `mainFrame` names the host of the document it shows now:
//     after destroy() it still reads the last host, and after crash() reading
//     it throws until a new document commits (Electron < 34).
//
// Used by tests that need to drive the Electron bridges (main + renderer)
// without booting a real Electron process.

import type {
  IpcMainEventLike,
  IpcMainLike,
  IpcRendererLike,
  WebContentsLike,
  WebFrameLike,
} from "../../../src/connectors/electron/types.js";

export interface FakeRenderer {
  /** The ipcRenderer of the document the WebContents shows now. */
  readonly ipcRenderer: IpcRendererLike;
  readonly sender: WebContentsLike;
  /** The IPC event the current document's messages carry. */
  readonly event: IpcMainEventLike;
  destroy(): void;
  /**
   * Commit a new document in the main frame (a reload or navigation), firing
   * `did-navigate`. With `swapFrame` the new document gets a new frame host,
   * and the old document's ipcRenderer keeps sending under the old host's ids
   * — the late messages of a page that has ended. Without it the host is
   * reused, and Chromium delivers the old document's IPC before the commit,
   * so the old ipcRenderer throws if used.
   */
  navigate(options?: { readonly swapFrame?: boolean }): void;
  /**
   * The renderer process dies; fires `render-process-gone`. Messages the
   * dead document queued before it died still arrive, under its ids.
   */
  crash(): void;
  /**
   * A main-frame load fails, firing `did-fail-load`. With `commitErrorPage`
   * an error page commits in a frame host of its own process — the old
   * document's ipcRenderer keeps sending under the old host's ids. Without
   * it nothing commits and the page stays shown.
   */
  failLoad(options: { readonly commitErrorPage: boolean }): void;
  /**
   * Visibility hook for leak regression tests: how many page listeners are
   * still attached to this fake's WebContents, over every event.
   */
  pageListenerCount(): number;
}

export interface IpcHub {
  readonly ipcMain: IpcMainLike;
  createRenderer(): FakeRenderer;
}

export function createIpcHub(): IpcHub {
  type InvokeHandler = (
    event: IpcMainEventLike,
    ...args: unknown[]
  ) => unknown | Promise<unknown>;
  type OnHandler = (event: IpcMainEventLike, ...args: unknown[]) => void;

  const invokeHandlers = new Map<string, InvokeHandler>();
  const mainOnListeners = new Map<string, Set<OnHandler>>();
  let nextProcessId = 1;

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
    interface Document {
      readonly frame: WebFrameLike;
      readonly listeners: Map<string, Set<RendererHandler>>;
      readonly ipcRenderer: IpcRendererLike;
      /** False once the document's frame host was reused by a later one. */
      sends: boolean;
    }

    let destroyed = false;
    let crashed = false;
    // Each listener mapped to whether it was attached with `once`.
    const pageListeners = new Map<string, Map<() => void, boolean>>();
    const processId = nextProcessId++;
    let nextRoutingId = 1;

    const attach = (event: string, listener: () => void, once: boolean) => {
      let map = pageListeners.get(event);
      if (!map) {
        map = new Map();
        pageListeners.set(event, map);
      }
      map.set(listener, once);
    };
    const fire = (event: string): void => {
      const map = pageListeners.get(event);
      if (!map) return;
      for (const [h, once] of [...map]) {
        if (once) map.delete(h);
        h();
      }
    };

    const sender: WebContentsLike = {
      send(channel, ...args) {
        if (destroyed) return;
        const set = doc.listeners.get(channel);
        if (!set) return;
        // Real Electron sends args through structuredClone before they
        // reach the renderer. Mirroring that here means a test that mutates
        // the source object after dispatch (or relies on by-ref identity)
        // fails the same way it would in production.
        for (const h of set) h({}, ...cloneArgs(args));
      },
      get mainFrame() {
        if (crashed) {
          throw new Error(
            "Render frame was disposed before WebFrameMain could be accessed",
          );
        }
        return doc.frame;
      },
      once(event, listener) {
        attach(event, listener, true);
      },
      on(event, listener) {
        attach(event, listener, false);
      },
      removeListener(event, listener) {
        pageListeners.get(event)?.delete(listener);
      },
      isDestroyed() {
        return destroyed;
      },
      isCrashed() {
        return crashed;
      },
    };

    function createDocument(frame: WebFrameLike): Document {
      const listeners = new Map<string, Set<RendererHandler>>();
      const event = (): IpcMainEventLike => {
        if (!document.sends) {
          throw new Error(
            "this document's frame host was reused by a later document; " +
              "Chromium delivered its IPC before the navigation committed",
          );
        }
        return {
          sender,
          processId: frame.processId,
          frameId: frame.routingId,
        };
      };
      const ipcRenderer: IpcRendererLike = {
        async invoke(channel, ...args) {
          const handler = invokeHandlers.get(channel);
          if (handler === undefined) {
            throw new Error(`no handler registered for ${channel}`);
          }
          const result = await handler(event(), ...cloneArgs(args));
          return cloneArgs([result])[0];
        },
        send(channel, ...args) {
          const e = event();
          const set = mainOnListeners.get(channel);
          if (!set) return;
          for (const h of set) h(e, ...cloneArgs(args));
        },
        on(channel, listener) {
          let set = listeners.get(channel);
          if (!set) {
            set = new Set();
            listeners.set(channel, set);
          }
          set.add(listener as RendererHandler);
        },
        removeListener(channel, listener) {
          listeners.get(channel)?.delete(listener as RendererHandler);
        },
      };
      const document: Document = { frame, listeners, ipcRenderer, sends: true };
      return document;
    }

    let doc = createDocument({ processId, routingId: nextRoutingId++ });

    return {
      get ipcRenderer() {
        return doc.ipcRenderer;
      },
      sender,
      get event() {
        return {
          sender,
          processId: doc.frame.processId,
          frameId: doc.frame.routingId,
        };
      },
      destroy() {
        destroyed = true;
        fire("destroyed");
      },
      navigate({ swapFrame = false } = {}) {
        const old = doc;
        old.sends = swapFrame;
        doc = createDocument(
          swapFrame ? { processId, routingId: nextRoutingId++ } : old.frame,
        );
        crashed = false;
        fire("did-navigate");
      },
      crash() {
        crashed = true;
        fire("render-process-gone");
      },
      failLoad({ commitErrorPage }) {
        if (commitErrorPage) {
          doc = createDocument({
            processId: nextProcessId++,
            routingId: nextRoutingId++,
          });
        }
        fire("did-fail-load");
      },
      pageListenerCount: () =>
        [...pageListeners.values()].reduce((n, m) => n + m.size, 0),
    };
  }

  return { ipcMain, createRenderer };
}

export function cloneArgs(args: readonly unknown[]): unknown[] {
  return args.map((a) => structuredClone(a));
}
