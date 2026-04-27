// examples/xterm-electron/preload.ts
// Runs with sandbox: true + contextIsolation: true.
// Exposes the ipcRenderer surface required by `createRendererBridge` under
// window.tmuxIpc — no other IPC is reachable from the renderer.
//
// The exposed object is structurally assignable to IpcRendererLike, which is
// the library's minimal contract — so the renderer can pass it straight into
// createRendererBridge with zero casts.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { createWrapperTracker } from "./wrapper-tracker.js";

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

// Listener-wrapper bookkeeping. The previous version used a single
// WeakMap<listener, wrapper> slot — a leak waiting to happen on double
// subscribe. The wrapper-tracker keeps one bookkeeping entry per `on()`
// call so removeListener is LIFO-symmetric. See ./wrapper-tracker.ts for
// the full rationale and the unit tests in tests/unit for the contract.
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
