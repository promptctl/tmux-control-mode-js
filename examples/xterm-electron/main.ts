// examples/xterm-electron/main.ts
// Electron main-process entry for the xterm.js demo.
//
// Responsibilities:
//   1. Create-or-attach a dedicated tmux session and wrap it in TmuxClient.
//   2. Wire the client into Electron's IPC via createMainBridge — no
//      per-method ipcMain.handle boilerplate.
//   3. Create a BrowserWindow with contextIsolation + sandbox true (the
//      hardened default) and load the renderer.
//   4. Clean up the client when the last window closes.

import { execSync } from "node:child_process";
import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";

import { TmuxClient } from "@promptctl/tmux-control-mode-js";
import { spawnTmux } from "@promptctl/tmux-control-mode-js";
import { createMainBridge } from "@promptctl/tmux-control-mode-js/electron/main";

const SESSION = "xterm-electron-demo";

function ensureSession(): void {
  // `has-session` exits 0 when the session exists, non-zero otherwise.
  // Try to create; swallow the error when it already exists.
  try {
    execSync(`tmux has-session -t ${SESSION}`, { stdio: "ignore" });
  } catch {
    execSync(`tmux new-session -d -s ${SESSION}`, { stdio: "ignore" });
  }
}

function createClient(): TmuxClient {
  ensureSession();
  const transport = spawnTmux(["attach-session", "-t", SESSION]);
  return new TmuxClient(transport);
}

/**
 * Wait for tmux's initial attach handshake to settle. tmux emits a spurious
 * `%begin`/`%end` pair as part of `attach-session`, plus `%session-changed`.
 * If the renderer sends a command before that noise has been consumed, the
 * stray `%end` pops its pending entry off the FIFO with an empty response.
 *
 * The library's own integration tests use the same `session-changed`
 * boundary to decide when the client is quiescent (see
 * tests/integration/client.test.ts).
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

async function createWindow(client: TmuxClient): Promise<void> {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    backgroundColor: "#0b1120",
    title: "tmux-control-mode-js — Electron demo",
    // When TMUX_DEMO_HEADLESS=1 (the e2e harness sets this) the window is
    // not displayed; the renderer still runs and Playwright can drive it.
    show: process.env.TMUX_DEMO_HEADLESS !== "1",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // The bridge installs ipcMain.handle for "tmux:invoke" plus subscriber
  // registration on "tmux:register" / "tmux:unregister". Lives for the
  // lifetime of the client.
  const bridge = createMainBridge(client, ipcMain);

  win.on("closed", () => {
    bridge.dispose();
  });

  await win.loadFile(path.join(__dirname, "..", "index.html"));
}

app.whenReady().then(async () => {
  const client = createClient();
  await waitUntilReady(client);
  await createWindow(client);

  app.on("window-all-closed", () => {
    client.close();
    app.quit();
  });
});
