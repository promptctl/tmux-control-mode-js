// examples/web-multiplexer/electron/main.ts
// Electron main-process entry for the web-multiplexer demo.
//
//   1. Create-or-attach a dedicated tmux session (isolated -L socket so
//      e2e runs cannot collide with the developer's default server).
//   2. Wrap it in TmuxClient and install createMainBridge ONCE on
//      app.whenReady — ipcMain is a process singleton, so a per-window
//      registration would crash the second window.
//   3. Wait for tmux's `session-changed` so attach-session's spurious
//      %begin/%end pair has cleared the FIFO before any renderer can
//      send a command (the same gate the integration tests use).
//   4. Open a BrowserWindow with contextIsolation+sandbox enabled and
//      load the renderer bundle Vite produced under dist/electron/.

import { execSync } from "node:child_process";
import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";

import { TmuxClient, spawnTmux } from "@promptctl/tmux-control-mode-js";
import {
  createMainBridge,
  type MainBridgeHandle,
  type MainBridgeOptions,
} from "@promptctl/tmux-control-mode-js/electron/main";

// [LAW:single-enforcer] One pair of (socket, session) names drives every
// tmux invocation in this demo. Both default to `web-multiplexer-demo`
// but can be overridden via env so e2e runs are inherently isolated.
const SOCKET = process.env.TMUX_DEMO_SOCKET ?? "web-multiplexer-demo";
const SESSION = process.env.TMUX_DEMO_SESSION ?? "web-multiplexer-demo";

function ensureSession(): void {
  try {
    execSync(`tmux -L ${SOCKET} has-session -t ${SESSION}`, {
      stdio: "ignore",
    });
  } catch {
    execSync(`tmux -L ${SOCKET} new-session -d -s ${SESSION}`, {
      stdio: "ignore",
    });
  }
}

function createClient(): TmuxClient {
  ensureSession();
  const transport = spawnTmux(["-L", SOCKET, "attach-session", "-t", SESSION]);
  return new TmuxClient(transport);
}

/**
 * Wait for tmux's initial attach handshake to settle. tmux emits a
 * spurious `%begin`/`%end` pair as part of `attach-session`, plus
 * `%session-changed`. Any command sent before that noise has cleared
 * pops a stray `%end` off the FIFO with an empty response.
 */
function waitUntilReady(client: TmuxClient): Promise<void> {
  return new Promise((resolve) => {
    const handler = (): void => {
      client.off("session-changed", handler);
      resolve();
    };
    client.on("session-changed", handler);
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0b1120",
    title: "tmux-control-mode-js — Multiplexer (Electron)",
    show: process.env.TMUX_DEMO_HEADLESS !== "1",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Vite multi-page build emits the electron renderer at
  // dist/electron/index.html (relative to the demo workspace root). The
  // electron main bundle lives at dist-electron/main.mjs (esbuild
  // output), so the path goes ../dist/electron/index.html.
  await win.loadFile(path.join(__dirname, "..", "dist", "electron", "index.html"));
}

function bridgeOptions(): MainBridgeOptions {
  const high = process.env.TMUX_BRIDGE_HIGH_WATERMARK;
  const low = process.env.TMUX_BRIDGE_LOW_WATERMARK;
  return {
    ...(high !== undefined
      ? { outputHighWatermark: Number.parseInt(high, 10) }
      : {}),
    ...(low !== undefined
      ? { outputLowWatermark: Number.parseInt(low, 10) }
      : {}),
  };
}

app.whenReady().then(async () => {
  const client = createClient();
  await waitUntilReady(client);

  const bridge: MainBridgeHandle = createMainBridge(
    client,
    ipcMain,
    bridgeOptions(),
  );

  // By the time `window-all-closed` fires, every BrowserWindow has
  // already emitted its 'closed' event and its WebContents is destroyed,
  // so the %exit notification client.close() will emit cannot be
  // observed by any renderer in this code path. That is intentional:
  // a renderer's `on('exit')` handler is useful when tmux dies
  // UNEXPECTEDLY mid-session (parent crash, server kill) while a window
  // is still alive; during normal app shutdown the renderer is already
  // gone, so the absence of an exit hop is correct. If you ever need
  // exit to be observable for a graceful-shutdown UI, move
  // `client.close()` into `app.on('before-quit', ...)` so it runs while
  // windows are still alive — at the cost of dealing with the
  // before-quit-blocking dance Electron requires.
  app.on("window-all-closed", () => {
    bridge.dispose();
    client.close();
    app.quit();
  });

  await createWindow();
});
