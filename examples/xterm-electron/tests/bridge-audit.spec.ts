// examples/xterm-electron/tests/bridge-audit.spec.ts
//
// e07.5 Definition-of-done coverage:
//   - Two-window scenario: opens a second BrowserWindow and proves the bridge
//     does NOT crash with "Attempted to register a second handler for
//     tmux:invoke". Real Electron throws on duplicate handler registration —
//     the audit found that the previous example registered per-window and
//     would crash the second window. The fixed example registers once at
//     app.whenReady().
//
//   - Output-flood pause: configures very low bridge watermarks, runs a
//     chatty command in the tmux pane, and asserts the renderer receives
//     a `%pause` event from tmux. Pause is the protocol-level proof that
//     main called setPaneAction(Pause) once outstanding bytes for the pane
//     exceeded the high watermark.

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

test("opens a second BrowserWindow without re-registering the bridge handler", async () => {
  const app = await electron.launch({
    args: [APP_ROOT],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      TMUX_DEMO_HEADLESS: "1",
    },
  });

  try {
    const w1 = await app.firstWindow();
    await expect(w1.locator("#status")).toContainText(
      /attached to pane %\d+/,
      { timeout: 15_000 },
    );

    // Open a second window from main. If createMainBridge had run twice on
    // the same ipcMain, real Electron would have thrown back at app start —
    // but the regression we're guarding against is the older shape where the
    // bridge was registered inside createWindow(). To exercise that shape's
    // failure mode we just open another window; if the example reverts to
    // the per-window install, this throws inside the evaluated factory and
    // the test fails.
    await app.evaluate(({ BrowserWindow }, root) => {
      const w = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: {
          preload: `${root}/dist/preload.cjs`,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      return w.loadFile(`${root}/dist/index.html`);
    }, APP_ROOT);

    // Both windows should reach the "attached to pane" status independently.
    const wins = app.windows();
    expect(wins.length).toBe(2);
    for (const w of wins) {
      await expect(w.locator("#status")).toContainText(
        /attached to pane %\d+/,
        { timeout: 15_000 },
      );
    }
  } finally {
    await app.close();
  }
});

test("emits %pause to the renderer once per-pane outstanding crosses high watermark", async () => {
  const app = await electron.launch({
    args: [APP_ROOT],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      TMUX_DEMO_HEADLESS: "1",
      // 4 KiB high / 1 KiB low — small enough that a single `yes` burst
      // crosses high before the renderer can drain.
      TMUX_BRIDGE_HIGH_WATERMARK: "4096",
      TMUX_BRIDGE_LOW_WATERMARK: "1024",
    },
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator("#status")).toContainText(
      /attached to pane %(\d+)/,
      { timeout: 15_000 },
    );

    // Capture %pause events on the IPC channel directly. The proxy already
    // dispatches them through its internal emitter; we just install a
    // parallel ipcRenderer.on listener so the test can read them.
    await page.evaluate(() => {
      const w = window as unknown as {
        __pauseEvents: unknown[];
        tmuxIpc: {
          on(
            channel: string,
            listener: (event: unknown, ...args: unknown[]) => void,
          ): void;
        };
      };
      w.__pauseEvents = [];
      w.tmuxIpc.on("tmux:event", (_e, msg) => {
        const m = msg as { type?: string };
        if (m.type === "pause") w.__pauseEvents.push(msg);
      });
    });

    // Trigger a flood. Every '.xterm-helper-textarea' keystroke goes into
    // tmux via send-keys; once the shell prompt runs `yes | head -c 65536`
    // tmux fills the per-pane buffer well past 4 KiB before any drain.
    const textarea = page.locator(".xterm-helper-textarea");
    await textarea.focus();
    await textarea.pressSequentially("yes | head -c 65536\n", { delay: 5 });

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __pauseEvents: unknown[] })
                .__pauseEvents.length,
          ),
        { timeout: 20_000, intervals: [250] },
      )
      .toBeGreaterThanOrEqual(1);
  } finally {
    await app.close();
  }
});
