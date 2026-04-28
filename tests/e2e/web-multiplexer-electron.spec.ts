// tests/e2e/web-multiplexer-electron.spec.ts
//
// End-to-end smoke for the web-multiplexer demo running on its Electron
// target. Replaces the e2e coverage that lived inside the deleted
// xterm-electron app. Asserts the assembled stack:
//
//     xterm keystroke → preload IPC → main → tmux send-keys
//                                              ↓
//                       shell echoes the bytes back
//                                              ↓
//     xterm rendered DOM ← IPC event ← main ← %output
//
// Out of scope (covered elsewhere):
//   - notification coverage  → tests/integration/client.test.ts (SPEC §23)
//   - bridge backpressure    → tests/integration/websocket-bridge.test.ts
//   - DOM correctness for output rendering / input / escape sequences
//                            → tmux-testing-6yp.5

import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { E2E_SOCKET_DIR, e2eSocketName } from "./socket-dir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Demo workspace root — Electron is launched against this directory so it
// reads the workspace's package.json `main` (dist-electron/main.mjs).
const APP_ROOT = resolve(__dirname, "..", "..", "examples", "web-multiplexer");

// [LAW:single-enforcer] Per-run unique socket PATH keeps the test's tmux
// server fully isolated from every other tmux on the system. The path is
// a regular file under E2E_SOCKET_DIR (a directory the e2e harness owns
// exclusively — see socket-dir.ts), and the Electron app reads it via
// TMUX_DEMO_SOCKET (main.ts switches to `tmux -S` when the value contains
// a slash). Cleanup can therefore never reach /tmp/tmux-$UID/default or
// any other socket the user owns: those live in a different directory we
// never operate in.
mkdirSync(E2E_SOCKET_DIR, { recursive: true });
const SOCKET = e2eSocketName(process.pid, Date.now());
const SESSION = "web-multiplexer-demo";

const APP_ENV = {
  ...process.env,
  TMUX_DEMO_HEADLESS: "1",
  TMUX_DEMO_SOCKET: SOCKET,
  TMUX_DEMO_SESSION: SESSION,
};

function killServer(): void {
  try {
    execSync(`tmux -S ${SOCKET} kill-server`, { stdio: "ignore" });
  } catch {
    // Server not running — fine.
  }
  // tmux removes the socket file when it exits cleanly; if it never came
  // up (kill-server hit "no server running") the file still exists as a
  // zero-byte residue that the prune pass would otherwise leave behind.
  // Unlink defensively — only ever the path we just created.
  try {
    rmSync(SOCKET, { force: true });
  } catch {
    // No file — fine.
  }
}

test.beforeEach(killServer);
test.afterAll(killServer);

test("web-multiplexer Electron round-trips xterm → tmux → xterm", async () => {
  const app = await electron.launch({
    args: [APP_ROOT],
    cwd: APP_ROOT,
    env: APP_ENV,
  });

  try {
    const page = await app.firstWindow();

    // Phase 1: xterm mounts. The renderer waits for the first session +
    // window + pane subscription frames before rendering PaneView, so
    // .xterm being visible proves the full subscription loop ran:
    //   ElectronBridge.connect → main attach-session → first session
    //   notification → MobX store update → React render.
    await expect(page.locator(".xterm").first()).toBeVisible({
      timeout: 20_000,
    });

    // Phase 2: type a sentinel into the active pane. xterm forwards the
    // keystrokes through its hidden helper textarea; PaneTerminal calls
    // store.sendKeysToPane → ElectronBridge.sendKeys → preload IPC → main
    // → tmux send-keys → shell. We embed a unique sentinel so any prior
    // shell history echo can't produce a false positive.
    const SENTINEL = `E2E_${Date.now().toString(36).toUpperCase()}`;
    const textarea = page.locator(".xterm-helper-textarea").first();
    await textarea.focus();
    await textarea.pressSequentially(`printf ${SENTINEL}\n`, { delay: 10 });

    // Phase 3: the shell's printf output must land in the rendered xterm
    // grid via the %output → IPC event → xterm.write path. Asserting
    // presence is enough — the typed line and the printf output both
    // contain the sentinel, but quantity would add fragility without
    // value.
    await expect(page.locator(".xterm-rows").first()).toContainText(SENTINEL, {
      timeout: 15_000,
    });
  } finally {
    await app.close();
  }
});
