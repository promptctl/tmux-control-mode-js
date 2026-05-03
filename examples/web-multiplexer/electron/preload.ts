// examples/web-multiplexer/electron/preload.ts
// Runs with sandbox: true + contextIsolation: true.
// Exposes the ipcRenderer surface required by `createRendererBridge` under
// window.tmuxIpc — no other IPC is reachable from the renderer.
//
// The exposed object is structurally assignable to IpcRendererLike, the
// library's minimal contract — the multiplexer's main-electron.tsx hands
// it straight to ElectronBridge with no casts.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { createWrapperTracker } from "./wrapper-tracker.ts";

const TMUX_CHANNELS = new Set([
  "tmux:event",
  "tmux:invoke",
  "tmux:register",
  "tmux:unregister",
  "tmux:ack",
]);

function assertChannel(channel: string): void {
  if (!TMUX_CHANNELS.has(channel)) {
    throw new Error(
      `tmuxIpc: channel "${channel}" is not in the tmux bridge allowlist`,
    );
  }
}

type Wrapper = (event: IpcRendererEvent, ...args: unknown[]) => void;
type Listener = (...args: unknown[]) => void;

const tracker = createWrapperTracker<Listener, Wrapper>();

contextBridge.exposeInMainWorld("tmuxIpc", {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    assertChannel(channel);
    return ipcRenderer.invoke(channel, ...args);
  },

  send(channel: string, ...args: unknown[]): void {
    assertChannel(channel);
    ipcRenderer.send(channel, ...args);
  },

  on(channel: string, listener: Listener): void {
    assertChannel(channel);
    const wrapped: Wrapper = (_event, ...args): void => {
      listener(_event, ...args);
    };
    tracker.add(channel, listener, wrapped);
    ipcRenderer.on(channel, wrapped);
  },

  removeListener(channel: string, listener: Listener): void {
    assertChannel(channel);
    const wrapped = tracker.remove(channel, listener);
    if (wrapped === null) return;
    ipcRenderer.removeListener(channel, wrapped);
  },
});
