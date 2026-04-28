// examples/web-multiplexer/electron/preload.ts
// Runs with sandbox: true + contextIsolation: true.
//
// Exposes two API surfaces, each on its own contextBridge name:
//
//   window.tmuxIpc — the ipcRenderer surface required by the library's
//     `createRendererBridge`. Structurally assignable to IpcRendererLike
//     so the multiplexer's main-electron.tsx hands it straight to
//     ElectronBridge with no casts.
//
//   window.demoIpc — demo-specific RPC for the socket picker. Strict
//     allowlist of methods (no generic invoke escape hatch). Lives on a
//     separate object so the library's bridge contract stays clean.

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

// Demo-only RPC for the socket picker. Each method is a fixed wrapper
// over its own ipcRenderer.invoke channel — no generic invoke surface
// is exposed, so the renderer can't reach anything outside this list.
contextBridge.exposeInMainWorld("demoIpc", {
  listSockets(): Promise<readonly string[]> {
    return ipcRenderer.invoke("demo:list-sockets") as Promise<
      readonly string[]
    >;
  },
  currentSocket(): Promise<string | null> {
    return ipcRenderer.invoke("demo:current-socket") as Promise<string | null>;
  },
  switchSocket(name: string): Promise<void> {
    return ipcRenderer.invoke("demo:switch-socket", name) as Promise<void>;
  },
});
