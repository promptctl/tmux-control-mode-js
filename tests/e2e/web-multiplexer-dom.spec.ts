// tests/e2e/web-multiplexer-dom.spec.ts
//
// Renderer-DOM coverage that integration tests can't reach. Drives
// examples/web-multiplexer/'s Electron target and asserts xterm.js
// rendering invariants the round-trip smoke (.spec.ts sibling) can't:
//
//   1. multi-line output renders onto distinct xterm rows
//   2. ANSI foreground escapes produce styled spans in the DOM
//   3. carriage-return overwrite renders correctly
//   4. the host's xterm options and addons reach the panes: an OSC 8 link
//      with a custom scheme reaches its link handler
//   5. a character takes the cells tmux counts, with nothing from the host
//
// Items 1-3 are from IMPL §11.3. The original §11.3 catalog
// listed these as "Playwright + xterm.js" because they can only be
// verified at the rendered-DOM layer — the integration suite covers
// the protocol path but not the visual outcome.
//
// Sibling tests (round-trip smoke, socket picker swap) live in
// tests/e2e/web-multiplexer-electron.spec.ts.

import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tmuxSocketDir } from "@promptctl/tmux-control-mode-js";

import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import { e2eSocketName } from "./socket-naming.js";
import { cleanSessionArgs, E2E_SHELL } from "./tmux-shell.js";

// [LAW:single-enforcer] All tmux subprocess invocations cross the
// process boundary as argv arrays. Mirrors the wrapper in the Electron
// main process and the sister electron spec.
function tmux(socket: string, args: readonly string[]): void {
  execFileSync("tmux", ["-L", socket, ...args], { stdio: "ignore" });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..", "..", "examples", "web-multiplexer");

// One isolated socket per test, allocated lazily so each test gets a
// fresh tmux server. Storing the name in a closure shared with cleanup
// avoids the bookkeeping mistakes a per-test global would invite.
function freshSocket(): string {
  return e2eSocketName(
    process.pid,
    Date.now() + Math.floor(Math.random() * 1000),
  );
}

function killSocket(name: string): void {
  killTmuxServer(name);
  try {
    rmSync(join(tmuxSocketDir(), name), { force: true });
  } catch {
    // Best effort.
  }
}

interface AppHandle {
  socket: string;
  app: ElectronApplication;
  page: Page;
}

async function launchApp(): Promise<AppHandle> {
  const socket = freshSocket();
  // Seed the session with a clean shell BEFORE the app boots so its
  // ensureSession attaches instead of spawning the developer's login shell —
  // the DOM assertions below need a quiet, deterministic pane. See
  // tmux-shell.ts.
  tmux(socket, cleanSessionArgs("web-multiplexer-demo"));
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
  // [LAW:single-enforcer] killSocket must run unconditionally — it owns
  // cleanup of THIS test's per-run socket, and a Playwright/Electron
  // shutdown reject would otherwise leak the tmux server into
  // subsequent runs.
  try {
    await handle.app.close();
  } finally {
    killSocket(handle.socket);
  }
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
    const styled = page.locator('.xterm-rows span[class*="xterm-fg-"]', {
      hasText: SENTINEL,
    });
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
    await textarea.pressSequentially(`printf '${PRE}\\rXX\\n'\n`, {
      delay: 10,
    });

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

// The cell width the window terminal lays the grid out in, in CSS px.
async function cellWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".wt-grid");
    return parseFloat(grid?.style.getPropertyValue("--wt-cell-w") ?? "");
  });
}

test("an OSC 8 link with a custom scheme calls the page's link handler with its URI on click", async () => {
  const handle = await launchApp();
  try {
    const { page } = handle;
    const TAG = Date.now().toString(36).toUpperCase();
    const URI = `cc-candybar://dispatch/${TAG}`;
    const textarea = page.locator(".xterm-helper-textarea").first();
    await textarea.focus();
    // The link text is printed from two arguments, so only the output row
    // holds it whole; the typed command shows "LINK_ <tag>".
    await textarea.pressSequentially(
      `printf '\\033]8;;${URI}\\033\\\\%s%s\\033]8;;\\033\\\\\\n' LINK_ ${TAG}\n`,
      { delay: 10 },
    );
    const row = page
      .locator(".xterm-rows > div")
      .filter({ hasText: new RegExp(`^\\s*LINK_${TAG}\\s*$`) })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // tmux's 80 columns can be wider than the demo's box at its font, so the
    // window scrolls, and focusing xterm scrolled it toward the cursor. A
    // person scrolls back to the link's start to click it.
    await row.evaluate((r) => {
      const root = r.closest(".wt-root");
      if (root === null) throw new Error("link row is not in a window");
      root.scrollLeft = 0;
    });
    const box = await row.boundingBox();
    if (box === null) throw new Error("link row has no box");
    const x = box.x + (await cellWidth(page)) * 2.5;
    const y = box.y + box.height / 2;
    // xterm finds a link under the pointer as it moves, asynchronously, and
    // only a click on a link it has already found activates it. The pointer
    // cursor is its sign of having found one.
    // [LAW:no-ambient-temporal-coupling] Click on that state, not on time.
    await page.mouse.move(x - 4, y);
    await page.mouse.move(x, y);
    await expect(page.locator(".xterm-cursor-pointer")).toHaveCount(1);
    await page.mouse.click(x, y);
    await expect(page.getByTestId("last-link")).toHaveText(URI, {
      timeout: 5_000,
    });
  } finally {
    await disposeApp(handle);
  }
});

test("an emoji with VS16 takes two cells, as tmux counts it, with no Unicode addon from the host", async () => {
  const handle = await launchApp();
  try {
    const { page } = handle;
    const SENTINEL = `W${Date.now().toString(36).toUpperCase()}`;
    const textarea = page.locator(".xterm-helper-textarea").first();
    await textarea.focus();
    // U+26A0 U+FE0F (UTF-8 E2 9A A0 EF B8 8F), then the sentinel in red:
    // tmux counts the warning sign with VS16 two cells, where xterm's own
    // tables (Unicode 6, or 11 from its addon) count one.
    await textarea.pressSequentially(
      `printf '\\342\\232\\240\\357\\270\\217\\033[31m${SENTINEL}\\033[0m\\n'\n`,
      { delay: 10 },
    );
    const red = page
      .locator('.xterm-rows span[class*="xterm-fg-"]', { hasText: SENTINEL })
      .first();
    await expect(red).toBeVisible({ timeout: 15_000 });
    const offset = await red.evaluate((span) => {
      const rowEl = span.closest(".xterm-rows > div");
      if (rowEl === null) throw new Error("span outside a row");
      return (
        span.getBoundingClientRect().left - rowEl.getBoundingClientRect().left
      );
    });
    const cell = await cellWidth(page);
    expect(Math.abs(offset - 2 * cell)).toBeLessThan(cell / 2);
  } finally {
    await disposeApp(handle);
  }
});

test("a pane scrolled back by the wheel still shows its last column, with no scrollbar over it", async () => {
  const handle = await launchApp();
  try {
    const { page, socket } = handle;
    tmux(socket, [
      "send-keys",
      "-t",
      "web-multiplexer-demo",
      "seq -f n%g 1 60",
      "Enter",
    ]);
    const pane = page.locator(".wt-pane:not([hidden])").first();
    // `n60` is output's alone: the echoed command reads `n%g 1 60`.
    await expect(pane.locator(".xterm-rows")).toContainText("n60", {
      timeout: 15_000,
    });
    const box = await pane.boundingBox();
    if (box === null) throw new Error("the pane has no box");
    // Scrolling is what shows a scrollbar that otherwise fades out.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await expect(pane.locator(".xterm-rows")).not.toContainText("n60");
    // tmux's 80 columns can be wider than the demo's box, so the window
    // scrolls: bring the pane's right edge into view.
    await pane.evaluate((p) => {
      const root = p.closest(".wt-root");
      if (root === null) throw new Error("the pane is not in a window");
      root.scrollLeft = root.scrollWidth;
    });
    const edge = await pane.boundingBox();
    if (edge === null) throw new Error("the pane has no box");
    // What the pointer meets on the pane's last column, halfway down.
    const lastColumn = await page.evaluate(
      ({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        if (hit === null) return "nothing";
        return hit.closest(".scrollbar") !== null
          ? "scrollbar"
          : hit.closest(".xterm-screen") !== null
            ? "screen"
            : hit.className;
      },
      { x: edge.x + edge.width - 2, y: edge.y + edge.height / 2 },
    );
    expect(lastColumn).toBe("screen");
  } finally {
    await disposeApp(handle);
  }
});

test("each pane's xterm fills its pane box exactly, drawn by the DOM renderer or by WebGL", async () => {
  const handle = await launchApp();
  try {
    const { page, socket } = handle;
    // Two panes side by side: a cell width off by a fraction shows as the
    // right pane's xterm falling short of its box, or running past it.
    tmux(socket, [
      "split-window",
      "-h",
      "-t",
      "web-multiplexer-demo",
      E2E_SHELL,
    ]);
    // xterm sizes its screen element to its grid (cols x the cell its
    // renderer draws, rounded to whole CSS px); the pane's box is the
    // window terminal's cols x the cell it laid out.
    const fits = (): Promise<string[]> =>
      page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>(".wt-pane:not([hidden])"),
          (pane) => {
            const box = pane.getBoundingClientRect();
            const screen = pane.querySelector(".xterm-screen");
            if (screen === null) return `${pane.dataset.paneId}: no screen`;
            const drawn = screen.getBoundingClientRect();
            const renderer =
              screen.querySelector("canvas") === null ? "dom" : "canvas";
            const off = Math.max(
              Math.abs(drawn.width - box.width),
              Math.abs(drawn.height - box.height),
            );
            return `${renderer} ${off < 1 ? "fits" : `${drawn.width}x${drawn.height} in ${box.width}x${box.height}`}`;
          },
        ),
      );
    await expect
      .poll(fits, { timeout: 15_000 })
      .toEqual(["dom fits", "dom fits"]);
    await page.getByText("WebGL", { exact: true }).click();
    await expect
      .poll(fits, { timeout: 15_000 })
      .toEqual(["canvas fits", "canvas fits"]);
  } finally {
    await disposeApp(handle);
  }
});
