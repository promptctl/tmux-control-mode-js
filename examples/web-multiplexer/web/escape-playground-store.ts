// examples/web-multiplexer/web/escape-playground-store.ts
//
// EscapePlaygroundStore — the IO boundary for the escape-code playground. It
// owns one scratch resource: a dedicated tmux window running a raw-mode byte
// mirror (`sh -c "stty raw; exec cat"`), spawned on entering playground mode and
// killed on leaving it. Bytes the user composes are sent to that pane via the
// library's `sendKeys` (`send-keys -H`), and the pane's `%output` is rendered by
// an `ObservablePaneStream` / `XtermSink` in the view — the live round-trip that
// makes "input fidelity" something you can watch.
//
// Why a dedicated pane, and why `cat` in raw mode: `send-keys` writes to a
// program's *stdin*; escape sequences only reach the screen when they appear in
// the pane's *output*. A raw-mode `cat` is a transparent stdin→stdout mirror, so
// the exact bytes sent render exactly once (no line-discipline echo/buffering).
//
// Why the control client must *view* the scratch window: this demo's control
// client streams live `%output` only for the window it is currently viewing — a
// detached or merely session-active window's pane never reaches the browser
// (verified live against tmux 3.6a: a scratch pane rendered nothing until the
// control client ran `select-window` to view it, at which point its output
// streamed and rendered). So `spawn` creates the window detached, remembers the
// window the client was on, then `select-window`s the scratch window; `stop`
// restores the client to the remembered window (so the multiplexer streams it
// again on return) before killing the scratch one. The playground view occupies
// the whole main area, so moving the client's view is invisible to the user, and
// the user's own pane is never resized (a split would SIGWINCH it).
//
// [LAW:effects-at-boundaries] All IO (new-window / kill-window / sendKeys, the
//   pane stream) lives here; the byte classification it drives is the pure,
//   unit-tested `escape-parse-engine`. The view holds the input text and asks the
//   engine to analyze it; this store only spawns, sends, and tears down.
// [LAW:no-ambient-temporal-coupling] The scratch pane's lifecycle has exactly
//   one owner: `start` spawns, `stop` kills, a reconnect re-spawns. No other
//   code creates or destroys it.

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";

/**
 * The byte mirror. Raw mode disables the line discipline (no echo, no canonical
 * buffering, no signal generation) so `cat` copies stdin to stdout byte-for-byte
 * and the bytes we send render exactly once.
 */
const MIRROR_COMMAND = 'sh -c "stty raw; exec cat"';

/**
 * Spawn the scratch window detached (we point the client at it explicitly via
 * `select-window`) and print the new pane + window ids so we can target sends,
 * mount the renderer, and kill it on teardown. [LAW:one-source-of-truth] this
 * format string is the only place the spawn contract lives.
 */
const SPAWN_COMMAND = `new-window -d -P -F '#{pane_id} #{window_id}' '${MIRROR_COMMAND}'`;

/** Parse a `#{window_id}` reply (e.g. `@4`) into a numeric id. */
function parseWindowId(line: string | undefined): number | null {
  if (line === undefined) return null;
  const m = /^@(\d+)/.exec(line.trim());
  return m === null ? null : Number(m[1]);
}

export type PlaygroundStatus = "idle" | "spawning" | "ready" | "error";

/** Fixed scratch-pane geometry — compact enough to fit the playground column. */
const PLAYGROUND_COLS = 80;
const PLAYGROUND_ROWS = 24;

/** Parse a `#{pane_width};#{pane_height}` reply (e.g. `80;24`). */
function parsePaneSize(
  line: string | undefined,
): { cols: number; rows: number } | null {
  if (line === undefined) return null;
  const m = /^(\d+);(\d+)/.exec(line.trim());
  if (m === null) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}

/** Parse a `#{pane_id} #{window_id}` reply (e.g. `%5 @3`) into numeric ids. */
function parseSpawnReply(output: readonly string[]): {
  paneId: number;
  windowId: number;
} | null {
  const line = output[0];
  if (line === undefined) return null;
  const m = /^%(\d+)\s+@(\d+)/.exec(line.trim());
  if (m === null) return null;
  return { paneId: Number(m[1]), windowId: Number(m[2]) };
}

export class EscapePlaygroundStore {
  status: PlaygroundStatus = "idle";
  /**
   * The scratch pane id, once spawned. Send target + render source. The view
   * constructs its `ObservablePaneStream` from this id and mounts the terminal
   * in the same component — mirroring `PaneView`'s `PaneCell`, so the byte
   * stream and the xterm sink are created together with no attach-timing gap.
   */
  paneId: number | null = null;
  /**
   * The scratch pane's geometry, queried at spawn. The view hands this straight
   * to the XtermSink's `resize()` so the terminal gets its first resize (which
   * drains the seed/live buffer and paints) WITHOUT waiting on the per-pane size
   * subscription — that subscription emits only on a size *change*, which a
   * freshly created window never sees, so on its own it leaves the terminal
   * blank (verified live).
   */
  paneCols: number | null = null;
  paneRows: number | null = null;
  errorMsg: string | null = null;
  /** Bytes of the most recent send — a small "sent N bytes" confirmation. */
  lastSentBytes: number | null = null;

  private windowId: number | null = null;
  /** The window the control client was viewing before we hijacked its view. */
  private prevWindowId: number | null = null;
  private everReady = false;
  private readonly disposeOnState: () => void;

  constructor(private readonly bridge: TmuxBridge) {
    makeAutoObservable<
      this,
      "bridge" | "windowId" | "prevWindowId" | "everReady" | "disposeOnState"
    >(this, {
      bridge: false,
      windowId: false,
      prevWindowId: false,
      everReady: false,
      disposeOnState: false,
    });

    // A reconnect lands us on a (possibly new) server where the previous scratch
    // pane no longer exists. Re-spawn if the playground is still active so the
    // round-trip survives a socket swap / reconnect.
    this.disposeOnState = bridge.onState((state) => {
      if (state !== "ready") return;
      const wasReady = this.everReady;
      this.everReady = true;
      if (wasReady && this.isActive) void this.respawn();
    });
  }

  dispose(): void {
    this.disposeOnState();
    this.stop();
  }

  /** True from the moment a spawn begins until `stop` tears it down. */
  get isActive(): boolean {
    return this.status === "spawning" || this.status === "ready";
  }

  // -------------------------------------------------------------------------
  // Lifecycle (scratch pane)
  // -------------------------------------------------------------------------

  /** Spawn the scratch pane. Idempotent while already active. */
  start(): void {
    if (this.isActive) return;
    void this.spawn();
  }

  /**
   * Restore the client's view and kill the scratch window. Called on leaving
   * playground mode. Restore happens BEFORE the kill so the multiplexer streams
   * the user's window again on return.
   */
  stop(): void {
    const win = this.windowId;
    const prev = this.prevWindowId;
    this.teardownLocalState();
    if (win === null) return;
    // Best-effort teardown, run while leaving the mode: there is no recovery
    // path here and no error UI mounted, so a failure is surfaced (logged), not
    // escalated. [LAW:no-silent-failure] the catch LOGS the error rather than
    // discarding it — the common case (window/server already gone mid-reconnect)
    // and a genuine failure (tmux refusing the kill) are both made observable in
    // the console instead of vanishing.
    void (async () => {
      if (prev !== null) {
        await this.bridge
          .execute(`select-window -t @${prev}`)
          .catch((err: unknown) =>
            console.warn(`playground: restoring view to @${prev} failed`, err),
          );
      }
      await this.bridge
        .execute(`kill-window -t @${win}`)
        .catch((err: unknown) =>
          console.warn(
            `playground: killing scratch window @${win} failed`,
            err,
          ),
        );
    })();
  }

  private async spawn(): Promise<void> {
    runInAction(() => {
      this.status = "spawning";
      this.errorMsg = null;
    });
    try {
      // Remember the window the client is viewing so `stop` can restore it.
      const cur = await this.bridge.execute(
        "display-message -p '#{window_id}'",
      );
      const prev = parseWindowId(cur.output[0]);

      const r = await this.bridge.execute(SPAWN_COMMAND);
      const ids = parseSpawnReply(r.output);
      if (ids === null) {
        runInAction(() => {
          this.status = "error";
          this.errorMsg = `unexpected new-window reply: ${r.output.join(" ") || "(empty)"}`;
        });
        return;
      }

      // Point the control client at the scratch window so tmux streams its
      // %output to the browser (see header). This is the load-bearing step — a
      // window the client is not viewing never reaches the renderer.
      await this.bridge.execute(`select-window -t @${ids.windowId}`);

      // Give the scratch window a compact, fixed geometry so it fits the
      // playground column, then read back the geometry tmux actually applied.
      // The view feeds this to the XtermSink's first resize. [LAW:no-silent-
      // failure] if the size query comes back unparseable we fall back to a
      // sane default rather than leaving the terminal unsized (blank) forever.
      await this.bridge.execute(
        `resize-window -t @${ids.windowId} -x ${PLAYGROUND_COLS} -y ${PLAYGROUND_ROWS}`,
      );
      const sizeReply = await this.bridge.execute(
        `display-message -p -t %${ids.paneId} '#{pane_width};#{pane_height}'`,
      );
      const size = parsePaneSize(sizeReply.output[0]);

      runInAction(() => {
        this.prevWindowId = prev;
        this.paneId = ids.paneId;
        this.windowId = ids.windowId;
        this.paneCols = size?.cols ?? PLAYGROUND_COLS;
        this.paneRows = size?.rows ?? PLAYGROUND_ROWS;
        this.status = "ready";
      });
    } catch (err) {
      runInAction(() => {
        this.status = "error";
        this.errorMsg = err instanceof Error ? err.message : String(err);
      });
    }
  }

  private async respawn(): Promise<void> {
    // The previous pane is gone with the old server; drop local state and spawn
    // anew. We do NOT kill-window here — there is no live window to kill.
    this.teardownLocalState();
    await this.spawn();
  }

  private teardownLocalState(): void {
    runInAction(() => {
      this.paneId = null;
      this.paneCols = null;
      this.paneRows = null;
      this.windowId = null;
      this.prevWindowId = null;
      this.status = "idle";
      this.errorMsg = null;
    });
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  /**
   * Send the (already escape-interpreted) string to the scratch pane. The view
   * passes `analyze(input).interpreted` so the bytes sent are exactly the bytes
   * it displayed and classified. [LAW:one-source-of-truth] one interpreted
   * string drives display, classification, and the wire.
   *
   * `sendKeys` encodes via `send-keys -H utf8HexBytes(s)`, delivering every byte
   * verbatim — the whole point of the demo.
   */
  send(interpreted: string): void {
    if (this.status !== "ready" || this.paneId === null) return;
    runInAction(() => {
      this.lastSentBytes = new TextEncoder().encode(interpreted).length;
    });
    void this.bridge.sendKeys(`%${this.paneId}`, interpreted);
  }
}
