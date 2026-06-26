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
// Plus the multi-window single-handler invariant (tmux-connectors-hz1.5):
// createMainBridge is a process singleton installed ONCE on app.whenReady —
// NOT per BrowserWindow (main.ts step 3). A second window must therefore
// SHARE that one bridge rather than re-register the `tmux:invoke` handler;
// a per-window registration would trip the library's REGISTERED_IPC_MAINS
// guard (BRIDGE_ALREADY_REGISTERED) and real Electron's "second handler for
// tmux:invoke" throw. The multi-window test below opens a second window and
// proves both render + round-trip through the single bridge — green is the
// behavioral proof the invariant holds. [LAW:behavior-not-structure]
//
// NOTE on connection-state: the ticket names a "tmux:connection-state" IPC
// channel to assert is not re-registered. No such channel exists — the
// allowlist is `tmux:event/invoke/register/unregister/ack` (see preload.ts).
// Connection-state rides the unified `tmux:event` channel as a synthetic
// {type:"connection-state"} message: the main bridge sends each new sender a
// snapshot in its register handler (connectors/electron/main.ts), and the
// client emits transitions on the same stream. A second window's
// connection-state therefore flows through the SAME single bridge; the
// `.xterm` render below — which requires the subscription loop over that
// channel to complete — is its proof. [FRAMING:representation]
//
// Out of scope (covered elsewhere):
//   - notification coverage  -> tests/integration/client.test.ts (SPEC §23)
//   - bridge backpressure    -> tests/integration/websocket-bridge.test.ts
//   - DOM correctness for output rendering / input / escape sequences
//                            -> tmux-testing-6yp.5

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tmuxSocketDir } from "@promptctl/tmux-control-mode-js";

import { e2eSocketName } from "./socket-naming.js";
import { cleanSessionArgs } from "./tmux-shell.js";

// [LAW:single-enforcer] All tmux subprocess invocations cross the
// process boundary as argv arrays. Socket/session names never pass
// through shell parsing — mirrors the wrapper in the Electron main
// process (examples/web-multiplexer/electron/main.ts).
function tmux(socket: string, args: readonly string[]): void {
  execFileSync("tmux", ["-L", socket, ...args], { stdio: "ignore" });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Demo workspace root — Electron is launched against this directory so it
// reads the workspace's `main` (dist-electron/main.mjs).
const APP_ROOT = resolve(__dirname, "..", "..", "examples", "web-multiplexer");

// Built Electron artifacts. The second BrowserWindow the multi-window test
// opens must load the SAME preload + renderer the demo's own window uses, or
// it would not register against the one shared bridge the invariant is about.
// Mirrors main.ts's own path math: the esbuild main bundle and preload live
// in dist-electron/; the Vite renderer in dist/electron/. `build:electron`
// (run by the test:e2e script) produces all three.
const PRELOAD = join(APP_ROOT, "dist-electron", "preload.cjs");
const INDEX_HTML = join(APP_ROOT, "dist", "electron", "index.html");

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
    tmux(SOCKET, ["kill-server"]);
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
      tmux(name, ["kill-server"]);
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

// Each test starts from a freshly-seeded session: kill any prior server on
// our socket, then seed SESSION with a clean shell so the demo app attaches
// to it (rather than spawning the developer's login shell). See tmux-shell.ts.
test.beforeEach(() => {
  killServer();
  tmux(SOCKET, cleanSessionArgs(SESSION));
});
test.afterEach(killAltSockets);
test.afterAll(killServer);

// [LAW:one-source-of-truth] One expression of the "type a sentinel and watch
// it round-trip through the rendered xterm grid" behavior. Every window in
// every test proves its input → tmux → output path the same way: a unique
// sentinel embedded in a printf so a stale shell-history echo can never
// produce a false positive, then asserted present in the .xterm-rows DOM.
async function expectKeystrokeRoundTrip(
  page: Page,
  sentinel: string,
): Promise<void> {
  const textarea = page.locator(".xterm-helper-textarea").first();
  await textarea.focus();
  await textarea.pressSequentially(`printf ${sentinel}\n`, { delay: 10 });
  await expect(page.locator(".xterm-rows").first()).toContainText(sentinel, {
    timeout: 15_000,
  });
}

// Open a second BrowserWindow inside the ALREADY-RUNNING main process. The
// demo creates exactly one window on whenReady and exposes no window-open
// affordance, so the test drives Electron's main API directly. The new
// window replicates the demo's webPreferences verbatim (same preload, same
// isolation/sandbox) and loads the same renderer bundle, so its renderer
// boots the same ElectronBridge and registers as a SECOND sender on the one
// shared bridge — exactly the topology the single-handler invariant governs.
async function openSecondWindow(app: ElectronApplication): Promise<Page> {
  const [page] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(
      async ({ BrowserWindow }, paths) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: paths.preload,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        });
        await win.loadFile(paths.index);
      },
      { preload: PRELOAD, index: INDEX_HTML },
    ),
  ]);
  return page;
}

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

    // Phase 2 + 3: type a sentinel into the active pane and watch it land
    // back in the rendered xterm grid. xterm forwards the keystrokes through
    // its hidden helper textarea; PaneTerminal calls store.sendKeysToPane →
    // ElectronBridge.sendKeys → preload IPC → main → tmux send-keys → shell,
    // and the shell's printf output returns via %output → IPC event →
    // xterm.write. The unique sentinel rules out a stale shell-history echo.
    await expectKeystrokeRoundTrip(
      page,
      `E2E_${Date.now().toString(36).toUpperCase()}`,
    );
  } finally {
    await app.close();
  }
});

// [LAW:no-silent-failure] KNOWN-BROKEN, tracked by tmux-reconnect-bcz. The
// swap completes (badge updates to the new socket, keystrokes reach the new
// pane server-side — both verified) but the pane renders BLANK: after the
// disconnect→switch→reconnect cycle the store keeps stale topology on
// `closed`, so the PaneView is reused (same pane id %0) rather than remounted,
// and PaneStream's in-place reconnect re-seed never lands — neither the
// capture-pane seed nor live %output reach the rendered xterm. This is a
// reconnect/re-seed coordination bug ORTHOGONAL to the single-handler
// invariant this file's multi-window test covers, and was already red on
// master (pane output never rendered at all before the hz1.5 fixes). Marked
// fixme rather than deleted so the assertion stays visible; un-fixme is the
// acceptance criterion for tmux-reconnect-bcz.
test("socket picker swaps the demo's TmuxClient onto a different live socket", async () => {
  // Spin up an ALTERNATE isolated tmux server on a side socket, with a
  // shell session running. This represents "another live tmux on the
  // user's system that the picker should be able to switch into."
  const ALT_SOCKET = e2eSocketName(process.pid, Date.now() + 1);
  const ALT_SESSION = "alt";
  altSockets.add(ALT_SOCKET);
  tmux(ALT_SOCKET, cleanSessionArgs(ALT_SESSION));

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
    await expectKeystrokeRoundTrip(
      page,
      `SWAP_${Date.now().toString(36).toUpperCase()}`,
    );
  } finally {
    await app.close();
  }
});

test("a second BrowserWindow shares the single bridge (single-handler invariant)", async () => {
  const app = await electron.launch({
    args: [APP_ROOT],
    cwd: APP_ROOT,
    env: APP_ENV,
  });

  try {
    // First window boots and renders — the bridge is installed (once, on
    // whenReady) and serving sender #1.
    const first = await app.firstWindow();
    await expect(first.locator(".xterm").first()).toBeVisible({
      timeout: 20_000,
    });

    // Open a second window. If the demo had wired createMainBridge per
    // BrowserWindow (or anything re-registered tmux:invoke), the library's
    // REGISTERED_IPC_MAINS guard throws BRIDGE_ALREADY_REGISTERED and real
    // Electron throws "Attempted to register a second handler for
    // tmux:invoke" — the second renderer's register/invoke/event loop would
    // never complete and .xterm would never mount. A visible grid is the
    // behavioral proof that the bridge is a process singleton serving a
    // SECOND sender, not a re-registration. [LAW:behavior-not-structure]
    const second = await openSecondWindow(app);
    await expect(second.locator(".xterm").first()).toBeVisible({
      timeout: 20_000,
    });

    // Each window's own input → output path round-trips through the one
    // shared bridge. Distinct sentinels per window; the panes mirror the
    // same tmux session, so both sentinels surface in both grids — asserting
    // each window contains the one IT typed proves both senders' send-keys
    // dispatch and event fan-out are live on the single bridge.
    await expectKeystrokeRoundTrip(
      second,
      `WIN2_${Date.now().toString(36).toUpperCase()}`,
    );
    // The first window's attachment must survive the second's registration:
    // re-prove its round-trip AFTER the second sender joined, so a teardown
    // or re-register triggered by the second window would surface as a
    // failure here.
    await expectKeystrokeRoundTrip(
      first,
      `WIN1_${Date.now().toString(36).toUpperCase()}`,
    );
  } finally {
    await app.close();
  }
});
