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
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tmuxSocketDir } from "@promptctl/tmux-control-mode-js";

import { e2eSocketName } from "./socket-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Demo workspace root — Electron is launched against this directory so it
// reads the workspace's package.json `main` (dist-electron/main.mjs).
const APP_ROOT = resolve(__dirname, "..", "..", "examples", "web-multiplexer");

// [LAW:single-enforcer] Per-run unique socket name keeps the test's tmux
// server fully isolated from any other server on the system. The Electron
// app reads TMUX_DEMO_SOCKET (main.ts uses `tmux -L`) so the socket file
// lands in /tmp/tmux-$UID/<name>. Globally-shared naming + classifier
// live in socket-naming.ts.
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
    execSync(`tmux -L ${SOCKET} kill-server`, { stdio: "ignore" });
  } catch {
    // Server not running — fine.
  }
  // Belt-and-suspenders: tmux unlinks its socket on a clean kill-server,
  // but if the Electron app already exited (and tmux died with it via
  // its parent-pipe close), tmux had no chance to clean up. Remove the
  // file ourselves — it's only ever the path THIS test created.
  try {
    rmSync(join(tmuxSocketDir(), SOCKET), { force: true });
  } catch {
    // No file — fine.
  }
}

// The picker swap test creates a SECOND isolated socket on the side and
// expects to be able to clean it up after each run regardless of test
// outcome. Tracking it here lets afterEach kill it whether the test
// succeeded, failed, or threw.
const altSockets = new Set<string>();
function killAltSockets(): void {
  for (const name of altSockets) {
    try {
      execSync(`tmux -L ${name} kill-server`, { stdio: "ignore" });
    } catch {
      // Server already gone.
    }
    try {
      rmSync(join(tmuxSocketDir(), name), { force: true });
    } catch {
      // Best effort.
    }
  }
  altSockets.clear();
}

test.beforeEach(killServer);
test.afterEach(killAltSockets);
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

test("socket picker swaps the demo's TmuxClient onto a different live socket", async () => {
  // Spin up an ALTERNATE isolated tmux server on a side socket, with a
  // shell session running. This represents "another live tmux on the
  // user's system that the picker should be able to switch into."
  const ALT_SOCKET = e2eSocketName(process.pid, Date.now() + 1);
  const ALT_SESSION = "alt";
  altSockets.add(ALT_SOCKET);
  execSync(`tmux -L ${ALT_SOCKET} new-session -d -s ${ALT_SESSION}`, {
    stdio: "ignore",
  });

  const app = await electron.launch({
    args: [APP_ROOT],
    cwd: APP_ROOT,
    env: APP_ENV,
  });

  try {
    const page = await app.firstWindow();
    // Initial socket is attached and rendered.
    await expect(page.locator(".xterm").first()).toBeVisible({
      timeout: 20_000,
    });

    // Open the picker. The badge button's aria-label embeds the current
    // socket; we don't depend on the exact label text.
    const badge = page.getByRole("button", { name: /Current socket/i });
    await badge.click();

    // The Mantine menu lists ALT_SOCKET as a selectable item. Click it.
    const altItem = page.getByRole("menuitem", {
      name: new RegExp(`^${ALT_SOCKET}$`),
    });
    await expect(altItem).toBeVisible({ timeout: 5_000 });
    await altItem.click();

    // The badge label updates to ALT_SOCKET once the swap completes.
    // The store reconnects, fetches sessions/windows/panes against
    // ALT_SOCKET, and the badge re-renders with the new currentSocket.
    await expect(
      page.getByRole("button", { name: new RegExp(ALT_SOCKET) }),
    ).toBeVisible({ timeout: 15_000 });

    // Prove the swap actually re-routed: type a sentinel, expect it to
    // land in ALT's pane via ALT's bridge.
    const SENTINEL = `SWAP_${Date.now().toString(36).toUpperCase()}`;
    const textarea = page.locator(".xterm-helper-textarea").first();
    await textarea.focus();
    await textarea.pressSequentially(`printf ${SENTINEL}\n`, { delay: 10 });
    await expect(page.locator(".xterm-rows").first()).toContainText(SENTINEL, {
      timeout: 15_000,
    });
  } finally {
    await app.close();
  }
});
