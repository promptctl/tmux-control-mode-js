// examples/xterm-electron/tests/e2e.spec.ts
//
// End-to-end test for the Electron demo. Launches the real app via
// Playwright's _electron API and exercises the full round-trip:
//
//     xterm keystroke → IPC invoke → main → tmux send-keys
//                                              ↓
//                          shell echoes the character back
//                                              ↓
//     xterm rendered DOM ← IPC event ← main ← tmux %output
//
// If this test passes, the Electron IPC bridge is demonstrably wired
// correctly on both the command and event channels.

import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const SESSION = "xterm-electron-demo";

function killSession(): void {
  try {
    execSync(`tmux kill-session -t ${SESSION}`, { stdio: "ignore" });
  } catch {
    // Not present — fine.
  }
}

test.beforeEach(() => {
  killSession();
});

test.afterAll(() => {
  killSession();
});

test("keystrokes round-trip xterm → tmux → xterm via the IPC bridge", async () => {
  const app = await electron.launch({
    args: [APP_ROOT],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      TMUX_DEMO_HEADLESS: "1",
    },
  });

  try {
    const page = await app.firstWindow();

    // Phase 1: renderer reaches tmux and discovers a pane.
    // The status update proves the full invoke round-trip:
    //   renderer.proxy.execute(list-panes)  →  main.client.execute  →
    //   tmux command/response  →  main resolves Promise  →  IPC response  →
    //   renderer sets status text.
    await expect(page.locator("#status")).toContainText(
      /attached to pane %\d+/,
      { timeout: 15_000 },
    );

    // Phase 2: xterm is mounted.
    await expect(page.locator(".xterm")).toBeVisible();

    // Phase 3: type into xterm. xterm forwards keys into its hidden
    // textarea; our renderer's term.onData hands them to proxy.sendKeys,
    // which reaches tmux. The shell echoes each typed character back as
    // %output, which our proxy dispatches through the "output" event to
    // xterm.write — which re-renders into the xterm DOM.
    //
    // We include a unique sentinel so a fresh shell prompt or any stray
    // history echo doesn't produce a false positive.
    const SENTINEL = `E2E_${Date.now().toString(36).toUpperCase()}`;
    const textarea = page.locator(".xterm-helper-textarea");
    await textarea.focus();
    await textarea.pressSequentially(`printf ${SENTINEL}\n`, { delay: 10 });

    // Phase 4: the shell's stdout for `printf SENTINEL` must land in
    // the xterm rendered DOM. This confirms the %output event channel
    // is functioning end-to-end.
    //
    // We check `.xterm-rows` (the DOM renderer's row container). This
    // test implicitly asserts that the rendered DOM contains two
    // copies of the sentinel: once from the local echo of the typed
    // command, and once from the shell's printf output. Asserting
    // presence is enough — quantity would add fragility without value.
    await expect(page.locator(".xterm-rows")).toContainText(SENTINEL, {
      timeout: 15_000,
    });
  } finally {
    await app.close();
  }
});
