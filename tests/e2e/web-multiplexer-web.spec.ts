// tests/e2e/web-multiplexer-web.spec.ts
//
// End-to-end smoke for the web-multiplexer demo running on its WEB
// target — the same React/MobX renderer the Electron smoke
// (web-multiplexer-electron.spec.ts) exercises, but assembled through
// a real Vite-served bundle and a real WebSocket bridge instead of
// Electron IPC. Asserts the assembled stack:
//
//     xterm keystroke → WebSocketBridge.sendKeys → ws frame
//                                                        ↓
//                              examples/web-multiplexer/server/bridge.ts
//                                                        ↓
//                                                tmux send-keys
//                                                        ↓
//                                            shell echoes the bytes back
//                                                        ↓
//     xterm rendered DOM ← WebSocketBridge.onEvent ← ws frame ← %output
//
// Out of scope (covered elsewhere):
//   - bridge backpressure                → tests/integration/websocket-bridge.test.ts
//   - notification fan-out                → tests/integration/client.test.ts (SPEC §23)
//   - DOM correctness for output / input → tests/e2e/web-multiplexer-dom.spec.ts
//                                          (Electron-target equivalent)
//
// Why both targets need their own smoke despite sharing the renderer:
// the bridges are independent transports. Electron talks postMessage
// over Chromium contextIsolation; web talks JSON-over-WebSocket through
// a Node ws server. A shared-renderer regression in either layer would
// pass the integration suite (which probes the bridge server in
// isolation, not assembled with the bundle and a real browser).

import { test, expect } from "@playwright/test";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tmuxSocketDir } from "@promptctl/tmux-control-mode-js";

import { e2eSocketName } from "./socket-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..", "..", "examples", "web-multiplexer");

// [LAW:single-enforcer] Per-run isolation envelope: a unique tmux
// socket and a fresh pair of ports for the bridge + Vite servers. None
// of these may collide with whatever else the developer has open
// (their own tmux, their own running `npm run demo`, an unrelated
// e2e run on the same host).
const SOCKET = e2eSocketName(process.pid, Date.now());
const SESSION = "web-multiplexer-demo";

interface Harness {
  webPort: number;
  bridgePort: number;
  bridgeProc: ChildProcess;
  viteProc: ChildProcess;
}
let harness: Harness | null = null;

/**
 * Pick a free TCP port by binding `0` and reading what the OS
 * assigned. Theoretically races a competing binder for the freed
 * port, but on a developer laptop with no other concurrent allocator
 * the window is microseconds and the test will fail loudly via
 * EADDRINUSE if it ever loses — preferable to hard-coding ports that
 * will collide with `npm run demo`.
 */
function freePort(): Promise<number> {
  return new Promise((resolveFn, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("freePort: server returned no port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolveFn(port));
    });
  });
}

/**
 * Poll a TCP port for HTTP 200 (or any response that returns headers).
 *
 * Probes `localhost` (the same hostname Vite logs) so resolution
 * tries both IPv4 and IPv6 — Vite on macOS binds `::1` only when the
 * Node process happens to resolve `localhost` to `::1` first, so a
 * hard-coded `127.0.0.1` probe can race the server's bind family.
 */
async function waitForHttp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolveFn) => {
      const req = request(
        { host: "localhost", port, path: "/", method: "GET", timeout: 500 },
        (res) => {
          res.resume();
          resolveFn(res.statusCode !== undefined);
        },
      );
      req.on("error", () => resolveFn(false));
      req.on("timeout", () => {
        req.destroy();
        resolveFn(false);
      });
      req.end();
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `waitForHttp: port ${port} did not answer within ${timeoutMs}ms`,
  );
}

function killTmuxSocket(name: string): void {
  try {
    execSync(`tmux -L ${name} kill-server`, { stdio: "ignore" });
  } catch {
    // Server already gone — fine.
  }
  try {
    rmSync(join(tmuxSocketDir(), name), { force: true });
  } catch {
    // Best effort.
  }
}

async function killProc(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolveFn) => {
    proc.once("exit", () => resolveFn());
    proc.kill("SIGTERM");
    // Belt-and-suspenders — if SIGTERM is ignored, escalate.
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    }, 2000).unref();
  });
}

test.beforeAll(async () => {
  // Pre-create an isolated tmux server with one named session. The
  // bridge will attach to this session via TMUX_DEMO_SOCKET +
  // TMUX_DEMO_SESSION; the test asserts that keystrokes reach a real
  // shell running inside it.
  execSync(`tmux -L ${SOCKET} new-session -d -s ${SESSION}`, {
    stdio: "ignore",
  });

  const webPort = await freePort();
  const bridgePort = await freePort();

  // [LAW:locality-or-seam] The bridge and Vite are independent
  // processes joined only by env vars + a /ws proxy rule. Spawning
  // them here (instead of leaning on Playwright's `webServer` config)
  // keeps the per-run port allocation co-located with the test that
  // owns it, mirrors the Electron spec's inline lifecycle, and avoids
  // global-config state shared across unrelated specs.
  const env = {
    ...process.env,
    TMUX_DEMO_SOCKET: SOCKET,
    TMUX_DEMO_SESSION: SESSION,
    WEB_MULTIPLEXER_WEB_PORT: String(webPort),
    WEB_MULTIPLEXER_BRIDGE_PORT: String(bridgePort),
    // Quiet Vite so the test log isn't flooded with HMR chatter.
    VITE_CJS_TRACE: "false",
  };

  const bridgeProc = spawn("npx", ["--no-install", "tsx", "server/bridge.ts"], {
    cwd: APP_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const viteProc = spawn("npx", ["--no-install", "vite"], {
    cwd: APP_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Pipe child stdio to our own so a failed bootstrap surfaces the
  // real cause in Playwright's report instead of a silent timeout.
  bridgeProc.stdout?.on("data", (d) => process.stdout.write(`[bridge] ${d}`));
  bridgeProc.stderr?.on("data", (d) => process.stderr.write(`[bridge] ${d}`));
  viteProc.stdout?.on("data", (d) => process.stdout.write(`[vite] ${d}`));
  viteProc.stderr?.on("data", (d) => process.stderr.write(`[vite] ${d}`));

  harness = { webPort, bridgePort, bridgeProc, viteProc };

  // Vite is the user-facing endpoint and proxies /ws to the bridge.
  // Both must be up before the test loads the page; HTTP probes are
  // cheap and don't depend on log-line shape.
  await waitForHttp(bridgePort, 15_000);
  await waitForHttp(webPort, 30_000);
});

test.afterAll(async () => {
  if (harness !== null) {
    await killProc(harness.viteProc);
    await killProc(harness.bridgeProc);
    harness = null;
  }
  killTmuxSocket(SOCKET);
});

test("web-multiplexer (web target) round-trips xterm → tmux → xterm", async ({
  page,
}) => {
  if (harness === null) throw new Error("harness not initialized");
  const { webPort } = harness;

  await page.goto(`http://localhost:${webPort}/`);

  // Phase 1: xterm mounts. The renderer waits for the first session +
  // window + pane subscription frames before rendering PaneView, so
  // .xterm being visible proves the full subscription loop ran:
  //   WebSocketBridge.connect → bridge.ts attach-session → first
  //   session notification → MobX store update → React render.
  await expect(page.locator(".xterm").first()).toBeVisible({
    timeout: 30_000,
  });

  // Phase 2: type a sentinel into the active pane. xterm forwards the
  // keystrokes through its hidden helper textarea; PaneTerminal calls
  // store.sendKeysToPane → WebSocketBridge.sendKeys → ws frame →
  // bridge.ts → tmux send-keys → shell. We embed a unique sentinel so
  // any prior shell history echo can't produce a false positive.
  const SENTINEL = `WEB_${Date.now().toString(36).toUpperCase()}`;
  const textarea = page.locator(".xterm-helper-textarea").first();
  await textarea.focus();
  await textarea.pressSequentially(`printf ${SENTINEL}\n`, { delay: 10 });

  // Phase 3: the shell's printf output must land in the rendered xterm
  // grid via the %output → ws frame → WebSocketBridge.onEvent →
  // xterm.write path. Asserting presence is enough — the typed line
  // and the printf output both contain the sentinel, but quantity
  // would add fragility without value.
  await expect(page.locator(".xterm-rows").first()).toContainText(SENTINEL, {
    timeout: 15_000,
  });
});
