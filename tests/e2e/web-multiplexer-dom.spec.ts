// tests/e2e/web-multiplexer-dom.spec.ts
//
// Renderer-DOM coverage that integration tests can't reach. Drives
// examples/web-multiplexer/'s Electron target and asserts xterm.js
// rendering invariants the round-trip smoke (.spec.ts sibling) can't:
//
//   1. multi-line output renders onto distinct xterm rows
//   2. ANSI foreground escapes produce styled spans in the DOM
//   3. carriage-return overwrite renders correctly
//
// All three categories are from IMPL §11.3. The original §11.3 catalog
// listed these as "Playwright + xterm.js" because they can only be
// verified at the rendered-DOM layer — the integration suite covers
// the protocol path but not the visual outcome.
//
// Sibling tests (round-trip smoke, socket picker swap) live in
// tests/e2e/web-multiplexer-electron.spec.ts.

import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tmuxSocketDir } from "@promptctl/tmux-control-mode-js";

import { e2eSocketName } from "./socket-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..", "..", "examples", "web-multiplexer");

// One isolated socket per test, allocated lazily so each test gets a
// fresh tmux server. Storing the name in a closure shared with cleanup
// avoids the bookkeeping mistakes a per-test global would invite.
function freshSocket(): string {
  return e2eSocketName(process.pid, Date.now() + Math.floor(Math.random() * 1000));
}

function killSocket(name: string): void {
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

interface AppHandle {
  socket: string;
  app: import("@playwright/test").ElectronApplication;
  page: import("@playwright/test").Page;
}

async function launchApp(): Promise<AppHandle> {
  const socket = freshSocket();
  const app = await electron.launch({
    args: [APP_ROOT],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      TMUX_DEMO_HEADLESS: "1",
      TMUX_DEMO_SOCKET: socket,
      TMUX_DEMO_SESSION: "web-multiplexer-demo",
    },
  });
  const page = await app.firstWindow();
  // Wait for xterm to mount — same gate the smoke test uses.
  await expect(page.locator(".xterm").first()).toBeVisible({
    timeout: 20_000,
  });
  return { socket, app, page };
}

async function disposeApp(handle: AppHandle): Promise<void> {
  await handle.app.close();
  killSocket(handle.socket);
}

test("multi-line output lands on distinct xterm rows", async () => {
  const handle = await launchApp();
  try {
    const { page } = handle;
    const SENTINEL_A = `MA_${Date.now().toString(36).toUpperCase()}`;
    const SENTINEL_B = `MB_${Date.now().toString(36).toUpperCase()}`;

    const textarea = page.locator(".xterm-helper-textarea").first();
    await textarea.focus();
    // Two separate printf invocations chained with `;`. Each command
    // emits its sentinel on its own line; the shell prompt advances
    // between them. This is cleaner than one printf with embedded \n
    // because some shells/quoting paths through pressSequentially
    // suppress the escape interpretation, and the test's invariant is
    // about row layout, not about printf format-string semantics.
    await textarea.pressSequentially(
      `printf '${SENTINEL_A}\\n'; printf '${SENTINEL_B}\\n'\n`,
      { delay: 10 },
    );

    // xterm's DOM renderer emits one <div> per terminal row inside
    // .xterm-rows. The typed-input echo row contains BOTH sentinels
    // (the literal characters 'MA…\\n…MB…' appear as we type them), so
    // toContainText(SENTINEL_A) is satisfied by the echo row alone and
    // doesn't gate on the shell having actually executed the command.
    //
    // What we actually want is "a row whose trimmed text EQUALS the
    // sentinel" — that shape is only produced by printf's output stream
    // landing on its own line. The typed-echo row (which starts with
    // `printf '`) never matches; PS1 prompts and autosuggestions never
    // match either. Polling on this condition both waits for execution
    // AND proves the multi-line layout in one step.
    const hasOwnRow = (sentinel: string): Promise<boolean> =>
      page.evaluate((needle) => {
        const rows = document.querySelector(".xterm-rows");
        if (rows === null) return false;
        return Array.from(rows.children).some(
          (el) => (el.textContent ?? "").trim() === needle,
        );
      }, sentinel);

    await expect
      .poll(() => hasOwnRow(SENTINEL_A), { timeout: 15_000 })
      .toBe(true);
    await expect
      .poll(() => hasOwnRow(SENTINEL_B), { timeout: 15_000 })
      .toBe(true);
  } finally {
    await disposeApp(handle);
  }
});

test("ANSI \\033[31m foreground produces a styled span around the text", async () => {
  const handle = await launchApp();
  try {
    const { page } = handle;
    const SENTINEL = `ANSI_${Date.now().toString(36).toUpperCase()}`;

    const textarea = page.locator(".xterm-helper-textarea").first();
    await textarea.focus();
    // printf '\033[31m<sentinel>\033[0m\n' — set FG to red, write the
    // sentinel, reset. xterm.js (DOM renderer) wraps colored runs in a
    // <span class="xterm-fg-N ...">; ANSI 31 (red) maps to fg index 1.
    await textarea.pressSequentially(
      `printf '\\033[31m${SENTINEL}\\033[0m\\n'\n`,
      { delay: 10 },
    );

    // First wait for the sentinel to appear at all (round-trip done).
    await expect(page.locator(".xterm-rows").first()).toContainText(SENTINEL, {
      timeout: 15_000,
    });

    // Then assert it's wrapped in a span carrying any xterm-fg-* class.
    // We don't pin the exact index (1 for basic ANSI red) — what we're
    // proving is that color escapes survive the wire and reach the DOM
    // as styled output, not that xterm.js's color-table mapping matches
    // a specific snapshot.
    const styled = page.locator(
      '.xterm-rows span[class*="xterm-fg-"]',
      { hasText: SENTINEL },
    );
    await expect(styled.first()).toBeVisible({ timeout: 5_000 });
  } finally {
    await disposeApp(handle);
  }
});

test("carriage-return overwrite renders the post-CR characters in place", async () => {
  const handle = await launchApp();
  try {
    const { page } = handle;
    // The combined test sentinel is what we expect AFTER the CR
    // overwrite: 'XX' overwrites the first two chars of 'before',
    // leaving 'XXfore' on the row. Only the OVERWRITTEN form is
    // asserted — the pre-overwrite 'before' must NOT survive on screen.
    const TAIL = `_${Date.now().toString(36).toUpperCase()}`;
    const PRE = `before${TAIL}`;
    const POST = `XX${PRE.slice(2)}`; // "XXfore<TAIL>"

    const textarea = page.locator(".xterm-helper-textarea").first();
    await textarea.focus();
    // printf 'before<tail>\rXX\n' — write PRE, send \r so the cursor
    // jumps to col 0, write 'XX' overwriting the first two chars, then
    // \n to terminate the line. Final visible content of that row: POST.
    await textarea.pressSequentially(
      `printf '${PRE}\\rXX\\n'\n`,
      { delay: 10 },
    );

    // The overwritten form must be present.
    await expect(page.locator(".xterm-rows").first()).toContainText(POST, {
      timeout: 15_000,
    });

    // Stronger: prove the pre-CR text was overwritten in place rather
    // than landing on its own row. We can't just count "rows containing
    // TAIL" — shells with zsh-autosuggestions re-render the previous
    // command at the next prompt, and the typed-input echo also
    // contains TAIL inside the printf format string. Both produce
    // TAIL-bearing rows that are unrelated to CR semantics.
    //
    // What's unique to a CR failure is a row whose trimmed text STARTS
    // with `before<TAIL>` — that shape is only produced by printf's
    // output stream. The typed-echo row starts with `printf`, prompt
    // rows start with PS1 fragments, and the post-CR output starts
    // with `XXfore`. None of those start with `before`.
    const preCrRowExists = await page.evaluate((pre) => {
      const rows = document.querySelector(".xterm-rows");
      if (rows === null) return false;
      return Array.from(rows.children).some((el) =>
        (el.textContent ?? "").trim().startsWith(pre),
      );
    }, PRE);
    expect(preCrRowExists).toBe(false);
  } finally {
    await disposeApp(handle);
  }
});
