// examples/web-multiplexer/electron/main.ts
// Electron main-process entry for the web-multiplexer demo.
//
//   1. On app.whenReady, prune dead sockets in /tmp/tmux-$UID/ (skip
//      `default`) so the renderer's socket picker can trust the
//      directory listing without re-probing liveness.
//   2. Create-or-attach a dedicated tmux session and track it as ours;
//      we kill our own server on quit ([self-cleanup principle]: each
//      socket creator cleans up after itself).
//   3. Install createMainBridge ONCE on app.whenReady — ipcMain is a
//      process singleton, so a per-window registration would crash the
//      second window.
//   4. Expose IPC channels for the renderer's socket picker to list
//      live sockets and switch to one. Switching disposes the current
//      bridge + client, leaves the previous socket alone (we'll kill
//      our own at full quit time, not on switch — keeps ephemeral demo
//      sessions reachable through the picker until the app exits).
//   5. Open a BrowserWindow with contextIsolation+sandbox enabled and
//      load the renderer bundle Vite produced under dist/electron/.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";

import {
  TmuxClient,
  spawnTmux,
  tmuxSocketDir,
  listTmuxSocketNames,
  isTmuxServerAlive,
} from "@promptctl/tmux-control-mode-js";
import {
  createMainBridge,
  type MainBridgeHandle,
  type MainBridgeOptions,
} from "@promptctl/tmux-control-mode-js/electron/main";

// [LAW:single-enforcer] One pair of (socket, session) names drives the
// demo's INITIAL connection. Both default to `web-multiplexer-demo` but
// can be overridden via env so e2e runs are inherently isolated. After
// boot, the renderer's socket picker can swap us to any other live
// socket — see swapTo() below.
const INITIAL_SOCKET =
  process.env.TMUX_DEMO_SOCKET ?? "web-multiplexer-demo";
const INITIAL_SESSION =
  process.env.TMUX_DEMO_SESSION ?? "web-multiplexer-demo";

// Sockets the demo created itself. Only these get killed on quit;
// user-owned sockets the picker hops onto are read-only as far as we're
// concerned — we never created them, we never kill them.
const ourSockets = new Set<string>();

function tmux(socket: string, args: readonly string[]): string {
  // [LAW:single-enforcer] All Electron main-process tmux subprocess calls
  // cross the process boundary here via argv arrays. Socket/session names
  // never pass through shell parsing.
  return execFileSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function ensureSession(socket: string, session: string): void {
  try {
    tmux(socket, ["has-session", "-t", session]);
  } catch {
    tmux(socket, ["new-session", "-d", "-s", session]);
    ourSockets.add(socket);
  }
}

function pruneDeadSockets(): void {
  const dir = tmuxSocketDir();
  if (!existsSync(dir)) return;
  for (const name of listTmuxSocketNames()) {
    if (name === "default") continue; // hard skip — user's primary
    if (isTmuxServerAlive(name)) continue;
    try {
      rmSync(path.join(dir, name), { force: true });
    } catch {
      // Best effort.
    }
  }
}

function killOurSockets(): void {
  for (const name of ourSockets) {
    try {
      tmux(name, ["kill-server"]);
    } catch {
      // Server already gone — fine.
    }
    // tmux unlinks on a clean kill; if the server wasn't running the
    // file might still be there. Force-unlink as belt-and-suspenders.
    try {
      rmSync(path.join(tmuxSocketDir(), name), { force: true });
    } catch {
      // Best effort.
    }
  }
  ourSockets.clear();
}

function pickSessionOn(socket: string): string {
  // For sockets we did not create: list the live sessions and attach
  // to the first. tmux's `list-sessions -F #{session_name}` prints one
  // session name per line.
  try {
    const stdout = tmux(socket, ["list-sessions", "-F", "#{session_name}"]);
    const first = stdout.split("\n")[0]?.trim() ?? "";
    if (first.length > 0) return first;
  } catch {
    // No server / no sessions.
  }
  // Fallback: name a session after the socket. ensureSession will
  // create it if missing and add the socket to ourSockets.
  return socket;
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

// Mutable handle on the currently-attached client + bridge. The picker's
// switch-socket IPC handler swaps this in place; the demo never has more
// than one client active at a time.
interface Active {
  socket: string;
  session: string;
  client: TmuxClient;
  bridge: MainBridgeHandle;
}
let active: Active | null = null;

async function connectTo(socket: string, session: string): Promise<void> {
  ensureSession(socket, session);
  const transport = spawnTmux(["-L", socket, "attach-session", "-t", session]);
  const client = new TmuxClient(transport);
  await waitUntilReady(client);
  const bridge = createMainBridge(client, ipcMain, bridgeOptions());
  active = { socket, session, client, bridge };
}

async function swapTo(newSocket: string): Promise<void> {
  if (active === null) return;
  // [LAW:single-enforcer] One bridge installed at a time. Dispose first
  // so createMainBridge in connectTo() finds a clean ipcMain to register
  // on (REGISTERED_IPC_MAINS in the library throws otherwise).
  active.bridge.dispose();
  active.client.close();
  active = null;
  // Don't kill the previous socket here. If it's ours, killOurSockets
  // on quit takes care of it. If it's user-owned, it never was ours to
  // kill in the first place.
  const session = pickSessionOn(newSocket);
  await connectTo(newSocket, session);
}

app.whenReady().then(async () => {
  // Step 1 of the policy: prune dead sockets BEFORE we connect or the
  // picker enumerates. The picker reads `readdir(tmuxSocketDir())`
  // verbatim, so the dir must already be clean by the time the renderer
  // asks. See feedback: the picker never re-probes liveness; if a dead
  // socket appears in the list, this prune is the bug to chase.
  pruneDeadSockets();

  await connectTo(INITIAL_SOCKET, INITIAL_SESSION);

  // Renderer-facing IPC for the socket picker. Two channels, both
  // allowlisted in the preload (see preload.ts).
  ipcMain.handle("demo:list-sockets", () => {
    // Trust the directory: prune ran on whenReady, switch handlers will
    // not strand dead sockets, and each creator self-cleans on quit.
    //
    // `default` is the user's primary tmux server — explicitly INCLUDED
    // here. It's only the cleanup pass that hard-skips `default` (so we
    // never delete it); the picker shows it like any other live socket
    // because attaching to it is a normal, useful thing to do. The only
    // entry filtered out is the socket we're already attached to,
    // because picking it would be a no-op.
    return listTmuxSocketNames().filter((name) => name !== active?.socket);
  });
  ipcMain.handle("demo:current-socket", () => active?.socket ?? null);
  ipcMain.handle(
    "demo:switch-socket",
    async (_event, name: unknown): Promise<void> => {
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("demo:switch-socket: name must be a non-empty string");
      }
      await swapTo(name);
    },
  );

  // By the time `window-all-closed` fires, every BrowserWindow has
  // already emitted its 'closed' event and its WebContents is destroyed,
  // so the %exit notification client.close() will emit cannot be
  // observed by any renderer in this code path. That is intentional:
  // a renderer's `on('exit')` handler is useful when tmux dies
  // UNEXPECTEDLY mid-session (parent crash, server kill) while a window
  // is still alive; during normal app shutdown the renderer is already
  // gone, so the absence of an exit hop is correct.
  app.on("window-all-closed", () => {
    if (active !== null) {
      active.bridge.dispose();
      active.client.close();
      active = null;
    }
    // [self-cleanup principle] The demo created these sockets; nobody
    // else is going to clean them up. tmux unlinks on a clean
    // kill-server, but if the server is already gone the file lingers
    // — killOurSockets handles both cases.
    killOurSockets();
    app.quit();
  });

  await createWindow();
});
