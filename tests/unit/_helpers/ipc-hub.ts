// tests/unit/_helpers/ipc-hub.ts
// In-memory IPC hub that couples a fake IpcMain with one or more fake
// WebContents, each showing one page (document) at a time. Mirrors real
// Electron semantics:
//   - every cross-process hop (both sends, and an invoke's request) is
//     delivered in a later task, in the order it was sent: the receiving
//     process handles an IPC message as a task of its own, never inside the
//     sender's call stack.
//   - an invoke's return rides a pipe of its own, apart from
//     webContents.send, and overtakes every send main made before it — the
//     worst order real Electron delivers.
//   - a page that has ended (a later document committed, its renderer
//     crashed, or its WebContents was destroyed) hears nothing more from
//     main: no send, and no invoke reply, which stays pending forever.
//   - structuredClone on every cross-process arg (regressions that depend on
//     shared identity fail here the same way they'd fail in production); an
//     invoke handler's error crosses as a plain Error carrying only its
//     message, under Electron's "Error invoking remote method" prefix.
//   - webContents.send throws once the WebContents is destroyed.
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

import {
  IPC,
  type InvokeResultEnvelope,
  type InvokeReturn,
  type IpcMainEventLike,
  type IpcMainInvokeListener,
  type IpcMainLike,
  type IpcRendererLike,
  type IpcRendererOnListener,
  type WebContentsLike,
  type WebFrameLike,
} from "../../../src/connectors/electron/types.js";

/**
 * Electron's own `ipcRenderer`, untyped per channel, so a test playing a
 * hostile renderer can send main what `IpcRendererLike` refuses. It is
 * assignable to `IpcRendererLike`, as Electron's is.
 */
export interface RawIpcRenderer extends Pick<
  IpcRendererLike,
  "on" | "removeListener"
> {
  invoke(channel: string, ...args: unknown[]): Promise<InvokeReturn>;
  send(channel: string, ...args: unknown[]): void;
}

export interface FakeRenderer {
  /** The ipcRenderer of the document the WebContents shows now. */
  readonly ipcRenderer: RawIpcRenderer;
  readonly sender: WebContentsLike;
  /** The IPC event the current document's messages carry. */
  readonly event: IpcMainEventLike;
  destroy(): void;
  /**
   * Commit a new document in the main frame (a reload or navigation), firing
   * `did-navigate`. With `swapFrame` the new document gets a new frame host,
   * and the old document's ipcRenderer keeps sending under the old host's ids
   * — the late messages of a page that has ended, and the commit is
   * immediate. Without it the host is reused, and Chromium delivers the old
   * document's IPC before the commit: every message in flight lands first,
   * and the old ipcRenderer throws if used after.
   */
  navigate(options?: { readonly swapFrame?: boolean }): Promise<void>;
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
   * Every invoke reply main answered after its page ended: the value, or the
   * Error the page would have been rejected with. No page heard these.
   */
  readonly unheardReplies: readonly unknown[];
  /**
   * Visibility hook for leak regression tests: how many page listeners are
   * still attached to this fake's WebContents, over every event.
   */
  pageListenerCount(): number;
}

export interface IpcHub {
  readonly ipcMain: IpcMainLike;
  createRenderer(): FakeRenderer;
  /**
   * Resolves once no IPC message is in flight: every send and invoke leg
   * made so far, and any its delivery made before the next task, has been
   * delivered. A message a handler makes after a timer of its own is not
   * yet made, so it is not waited for.
   */
  settled(): Promise<void>;
}

export function createIpcHub(): IpcHub {
  type OnHandler = (event: IpcMainEventLike, ...args: unknown[]) => void;

  const invokeHandlers = new Map<string, IpcMainInvokeListener>();
  const mainOnListeners = new Map<string, Set<OnHandler>>();
  let nextProcessId = 1;

  // [LAW:no-ambient-temporal-coupling] one hop for every crossing, so no test
  // can rely on an ordering Electron never produces. Immediates fire in FIFO
  // order, which keeps each direction's messages in send order.
  const task = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));
  let inFlight = 0;
  const nextTask = (): Promise<void> => {
    inFlight++;
    return task().finally(() => inFlight--);
  };

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

  async function settled(): Promise<void> {
    // At least one task, so a send the caller's pending microtasks are about
    // to make is counted before the check.
    do await task();
    while (inFlight > 0);
  }

  function createRenderer(): FakeRenderer {
    interface Document {
      readonly frame: WebFrameLike;
      readonly listeners: Map<string, Set<IpcRendererOnListener>>;
      readonly ipcRenderer: RawIpcRenderer;
      /** A fresh IPC event for each message from this document, as Electron builds. */
      readonly ipcEvent: () => IpcMainEventLike;
      /** False once the document's frame host was reused by a later one. */
      sends: boolean;
    }

    let destroyed = false;
    let crashed = false;
    const unheardReplies: unknown[] = [];
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

    // [LAW:one-source-of-truth] a document hears main only while it is the
    // page shown in a live renderer; derived, never a flag of its own.
    const hears = (d: Document): boolean => !destroyed && !crashed && d === doc;

    // An invoke's request lands in main, and its return, value or error,
    // crosses back ahead of main's sends; a page that has ended never hears it.
    async function answer(
      from: Document,
      channel: string,
      args: readonly unknown[],
    ): Promise<InvokeReturn> {
      const payload = cloneArgs(args);
      await nextTask();
      const reply = await (async () => {
        const handler = invokeHandlers.get(channel);
        if (handler === undefined) {
          throw new Error(`No handler registered for '${channel}'`);
        }
        return structuredClone(await handler(from.ipcEvent(), ...payload));
      })().then(
        (value) => ({ ok: true, value }) as const,
        // Electron carries only the message across, under its prefix.
        (err: unknown) =>
          ({
            ok: false,
            error: new Error(
              `Error invoking remote method '${channel}': ${String(err)}`,
            ),
          }) as const,
      );
      if (!hears(from)) {
        unheardReplies.push(reply.ok ? reply.value : reply.error);
        return new Promise<never>(() => {});
      }
      if (!reply.ok) throw reply.error;
      return reply.value;
    }

    const sender: WebContentsLike = {
      send(channel, msg) {
        if (destroyed) throw new Error("Object has been destroyed");
        const target = doc;
        // Real Electron sends args through structuredClone before they
        // reach the renderer. Mirroring that here means a test that mutates
        // the source object after dispatch (or relies on by-ref identity)
        // fails the same way it would in production.
        const [payload] = cloneArgs([msg]);
        void nextTask().then(() => {
          if (!hears(target)) return;
          for (const h of target.listeners.get(channel) ?? []) h({}, payload);
        });
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
      const listeners = new Map<string, Set<IpcRendererOnListener>>();
      const mustSend = (): void => {
        if (!document.sends) {
          throw new Error(
            "this document's frame host was reused by a later document; " +
              "Chromium delivered its IPC before the navigation committed",
          );
        }
      };
      const ipcRenderer: RawIpcRenderer = {
        invoke(channel, ...args) {
          mustSend();
          return answer(document, channel, args);
        },
        send(channel, ...args) {
          mustSend();
          const payload = cloneArgs(args);
          void nextTask().then(() => {
            for (const h of mainOnListeners.get(channel) ?? [])
              h(document.ipcEvent(), ...payload);
          });
        },
        on(channel, listener) {
          let set = listeners.get(channel);
          if (!set) {
            set = new Set();
            listeners.set(channel, set);
          }
          set.add(listener);
        },
        removeListener(channel, listener) {
          listeners.get(channel)?.delete(listener);
        },
      };
      const document: Document = {
        frame,
        listeners,
        ipcRenderer,
        ipcEvent: () => ({
          sender,
          processId: frame.processId,
          frameId: frame.routingId,
        }),
        sends: true,
      };
      return document;
    }

    let doc = createDocument({ processId, routingId: nextRoutingId++ });

    return {
      get ipcRenderer() {
        return doc.ipcRenderer;
      },
      sender,
      unheardReplies,
      get event() {
        return doc.ipcEvent();
      },
      destroy() {
        destroyed = true;
        fire("destroyed");
      },
      async navigate({ swapFrame = false } = {}) {
        if (!swapFrame) await settled();
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

  return {
    ipcMain,
    createRenderer,
    settled,
  };
}

// Negative, so a raw invoke never shares an id with a proxy's on the page.
let lastRawId = 0;

/**
 * Invoke main with `req`, sent as is, and resolve with the reply wherever main
 * put it: on `IPC.event` under the invoke's id, or in the invoke's return.
 */
export function invokeRaw(
  ipc: RawIpcRenderer,
  req: unknown,
): Promise<InvokeResultEnvelope> {
  const id = --lastRawId;
  return new Promise((resolve, reject) => {
    const hear: IpcRendererOnListener = (_e, msg) => {
      if (msg.type !== "invoke-reply" || msg.id !== id) return;
      ipc.removeListener(IPC.event, hear);
      resolve(msg.result);
    };
    ipc.on(IPC.event, hear);
    ipc.invoke(IPC.invoke, id, req).then((ret) => {
      if (ret.via === "event") return;
      ipc.removeListener(IPC.event, hear);
      resolve(ret.result);
    }, reject);
  });
}

export function cloneArgs<T>(args: readonly T[]): T[] {
  return args.map((a) => structuredClone(a));
}
