// examples/xterm-electron/preload.ts
// Runs with sandbox: true + contextIsolation: true.
// Exposes the ipcRenderer surface required by `createRendererBridge` under
// window.tmuxIpc — no other IPC is reachable from the renderer.
//
// The exposed object is structurally assignable to IpcRendererLike, which is
// the library's minimal contract — so the renderer can pass it straight into
// createRendererBridge with zero casts.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const TMUX_CHANNELS = new Set([
  "tmux:event",
  "tmux:invoke",
  "tmux:register",
  "tmux:unregister",
]);

function assertChannel(channel: string): void {
  if (!TMUX_CHANNELS.has(channel)) {
    throw new Error(
      `tmuxIpc: channel "${channel}" is not in the tmux bridge allowlist`,
    );
  }
}

// Keep a handle to each renderer-side listener so removeListener works
// even though we wrap the caller's function with our own closure.
const wrappers = new WeakMap<
  (...args: unknown[]) => void,
  (event: IpcRendererEvent, ...args: unknown[]) => void
>();

contextBridge.exposeInMainWorld("tmuxIpc", {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    assertChannel(channel);
    return ipcRenderer.invoke(channel, ...args);
  },

  send(channel: string, ...args: unknown[]): void {
    assertChannel(channel);
    ipcRenderer.send(channel, ...args);
  },

  on(channel: string, listener: (...args: unknown[]) => void): void {
    assertChannel(channel);
    const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => {
      listener(_event, ...args);
    };
    wrappers.set(listener, wrapped);
    ipcRenderer.on(channel, wrapped);
  },

  removeListener(
    channel: string,
    listener: (...args: unknown[]) => void,
  ): void {
    assertChannel(channel);
    const wrapped = wrappers.get(listener);
    if (wrapped !== undefined) {
      ipcRenderer.removeListener(channel, wrapped);
      wrappers.delete(listener);
    }
  },
});
