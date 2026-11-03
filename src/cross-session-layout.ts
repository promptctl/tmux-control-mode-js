// src/cross-session-layout.ts
// Cross-session layout-change relay — tmux-server-events-6sp.1xs.
//
// tmux's own `%layout-change` notification is delivered only to a control
// client whose attached session contains the window that changed (SPEC.md
// §6.2) — unlike window-add/close/renamed, there is no "unlinked" fallback
// for layout-change, so a window changing in a session this client isn't
// attached to produces nothing at all. This module closes that gap using a
// global tmux hook (which bypasses control-notify's session gating entirely)
// relayed back through the existing `subscribe-changes` mechanism, decoded
// into a synthetic event distinct from native `%layout-change`.
//
// [LAW:one-source-of-truth] The hook command, option name, subscription
// name, and entry grammar are each defined exactly once, here.
// [LAW:no-silent-failure] Every path that drops data (a malformed/sheared
// entry, a vanished window) emits a diagnostic rather than swallowing.

import type { TmuxConnection } from "./client.js";
import { subscribeRaw, unsubscribe } from "./commands/index.js";
import type { SubscriptionChangedMessage } from "./protocol/types.js";

// ---------------------------------------------------------------------------
// Public synthetic event types — join SyntheticEmitterMessage in emitter.ts.
// Not TmuxMessage variants: tmux never sends a literal line for any of
// these, so they are not serializeMessage/TmuxParser round-trippable (the
// same reasoning that excludes ProtocolErrorMessage from TmuxMessage).
// ---------------------------------------------------------------------------

/**
 * A window's layout changed somewhere on the server. The global hook this
 * relay installs fires for every session, including this client's own
 * attached one — so this event can arrive for a window already covered by
 * a native `%layout-change`, by design (the ticket this shipped from:
 * "coverage isn't limited to what any consumer uses today"); a consumer
 * that only wants the gap this relay exists for (a window outside its own
 * attached session) filters on `sessionId`. `windowLayout`/
 * `windowVisibleLayout`/`windowFlags` are fetched by this client's own
 * control connection (which defaults to the classic checksum-string format
 * `%layout-change` itself uses — tmux 3.8 changed `#{window_layout}` to
 * render JSON by default for any context without `CLIENT_CONTROL`; fetching
 * via our own already-attached control client avoids that), so they are in
 * the same format as `LayoutChangeMessage`'s fields, not a different shape.
 */
export interface CrossSessionLayoutChangeMessage {
  readonly type: "cross-session-layout-change";
  readonly sessionId: number;
  readonly windowId: number;
  readonly windowLayout: string;
  readonly windowVisibleLayout: string;
  readonly windowFlags: string;
}

/**
 * The relay's queue decoder found bytes that don't match the entry grammar
 * at a point it expected an entry to start — either `CAP` truncation sheared
 * an entry at the front of the buffer, or a resync after a trim/truncation
 * landed mid-entry. The malformed span was skipped (up to and including the
 * next comma), not misinterpreted as a real identity pair.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutDecodeErrorMessage {
  readonly type: "cross-session-layout-decode-error";
  readonly skippedBytes: number;
}

/**
 * The follow-up `display-message` fetch for a decoded (sessionId, windowId)
 * pair failed — most likely the window closed between the hook firing and
 * this ~1s-delayed subscription delivery. Nothing to report (no layout
 * exists for a window that's gone); surfaced rather than left as a silently
 * dropped entry or an unhandled rejection.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutFetchFailedMessage {
  readonly type: "cross-session-layout-fetch-failed";
  readonly sessionId: number;
  readonly windowId: number;
}

export type CrossSessionLayoutMessage =
  | CrossSessionLayoutChangeMessage
  | CrossSessionLayoutDecodeErrorMessage
  | CrossSessionLayoutFetchFailedMessage;

// ---------------------------------------------------------------------------
// Reserved namespace — a second relayed hook (should tmux gain another
// gated-with-no-unlinked-fallback case) reuses this convention rather than
// re-deriving it.
// ---------------------------------------------------------------------------

/**
 * Hook array index reserved for this library's window-layout-changed relay.
 * Not index 0 — a human hand-editing `tmux.conf` almost certainly starts
 * there. [LAW:one-source-of-truth] The only place this number is written.
 */
const RESERVED_HOOK_INDEX = 9001;

const OPTION_NAME = "@ttcmjs-cross-session-layout";
const SUBSCRIPTION_NAME = "ttcmjs-cross-session-layout";

/**
 * Bytes retained in the relayed option, self-enforced by the hook's own
 * append command (independent of whether any consumer is subscribed to
 * drain it — see the module doc comment). tmux ids are monotonic per-server
 * counters, never reused: even an extreme, continuously busy server creating
 * a window or session every second for a full year reaches ~8 decimal
 * digits, and one maximally-wide entry (`$99999999:@99999999,`) is 20
 * bytes — 4096 holds ~204 such entries, far more than any plausible
 * same-tick burst (bounded in practice by how many windows actually exist
 * on the server).
 */
const CAP = 4096;

const ENTRY_RE = /^\$(\d+):@(\d+),/;

/**
 * The hook's canonical, idempotent command: append this window's identity
 * (never the layout string itself — see the module doc comment) to the
 * reserved option, atomically truncated to the last `CAP` bytes in the same
 * command so growth never depends on a subscriber being present to trim it.
 * `-F` is required: `set-option -g` without it stores the literal,
 * unexpanded `#{...}` text.
 */
function hookCommand(): string {
  return (
    `set-option -gF ${OPTION_NAME} ` +
    `"#{=-${CAP}:#{${OPTION_NAME}}#{session_id}:#{window_id},}"`
  );
}

function installHookCommand(): string {
  // set-hook takes hook-name + exactly one command argument — the inner
  // command (itself containing a double-quoted format string) must be
  // wrapped as a single tmux-parsed token. tmux's own command-line
  // tokenizer supports nested single/double quoting the same way a shell
  // does, so single-quoting the outer argument here works even though the
  // inner command already uses double quotes.
  return `set-hook -g window-layout-changed[${RESERVED_HOOK_INDEX}] '${hookCommand()}'`;
}

/**
 * One atomic check-and-clear: the comparison and the write both read the
 * same live server-side state at this single command's execution instant
 * (tmux's command queue is strictly serial), so there is no gap for a
 * concurrent hook append to land in between a check and a destructive
 * write. If the live value no longer equals `drainedSnapshot` (something
 * was appended since), the `else` branch is the option read back to itself
 * — a no-op, never destructive.
 *
 * `drainedSnapshot` is safe to interpolate literally: every byte in it
 * comes from the entry grammar (`$`, digits, `@`, `:`, `,`), which never
 * contains `#` — the one character that would need escaping here.
 */
function trimCommand(drainedSnapshot: string): string {
  return (
    `set-option -gF ${OPTION_NAME} ` +
    `"#{?#{==:#{${OPTION_NAME}},${drainedSnapshot}},,#{${OPTION_NAME}}}"`
  );
}

function fetchLayoutCommand(windowId: number): string {
  return `display-message -p -t @${windowId} "#{window_layout}\x01#{window_visible_layout}\x01#{window_flags}"`;
}

// ---------------------------------------------------------------------------
// Decoding — pure, no I/O, independently testable.
// ---------------------------------------------------------------------------

export interface DecodedEntry {
  readonly sessionId: number;
  readonly windowId: number;
}

export interface DecodeResult {
  readonly entries: readonly DecodedEntry[];
  readonly skips: readonly { readonly skippedBytes: number }[];
}

/**
 * Decode every `$sessionId:@windowId,` entry in `remainder` (already the
 * not-yet-processed suffix/whole-value per the caller's prefix-diff — see
 * {@link diffAgainstLastProcessed}). A non-match with non-empty remaining
 * text is a shear artifact (CAP truncation, or a resync landing mid-entry):
 * skip to the next `,` and resume, recording the skip rather than
 * misinterpreting the fragment as a real id. [LAW:parse-don't-validate]
 */
export function decodeEntries(remainder: string): DecodeResult {
  const entries: DecodedEntry[] = [];
  const skips: { skippedBytes: number }[] = [];
  let cursor = remainder;
  while (cursor.length > 0) {
    const m = ENTRY_RE.exec(cursor);
    if (m) {
      entries.push({ sessionId: Number(m[1]), windowId: Number(m[2]) });
      cursor = cursor.slice(m[0].length);
      continue;
    }
    const commaIdx = cursor.indexOf(",");
    if (commaIdx === -1) break;
    skips.push({ skippedBytes: commaIdx + 1 });
    cursor = cursor.slice(commaIdx + 1);
  }
  return { entries, skips };
}

/**
 * If `value` starts with `lastProcessedValue` (the common case: nothing but
 * new appends happened since the last delivery), only the new suffix is
 * unprocessed. Otherwise (an atomic trim ran, or CAP truncation sheared the
 * front since last time) the whole value is treated as unprocessed —
 * {@link decodeEntries}'s resync handles a sheared leading fragment, and
 * re-decoding a couple of already-seen entries near a trim/truncation
 * boundary is a harmless duplicate, not data loss.
 */
export function diffAgainstLastProcessed(
  value: string,
  lastProcessedValue: string,
): string {
  return value.startsWith(lastProcessedValue)
    ? value.slice(lastProcessedValue.length)
    : value;
}

// ---------------------------------------------------------------------------
// CrossSessionLayoutRelay
// ---------------------------------------------------------------------------

/**
 * Per-`TmuxClient` relay. Ref-counted `enable`/`disable` so more than one
 * local listener can ask for this coverage without duplicate subscriptions;
 * the global hook, once installed, is intentionally never torn down (see
 * module doc comment and the plan this ticket shipped from) — cross-process
 * ref-counting has no safe shared counter, and the hook's own command is
 * self-capping, so leaving it in place is simpler and strictly safer than a
 * teardown that could race another process's still-active coverage away.
 */
export class CrossSessionLayoutRelay {
  private refCount = 0;
  private lastProcessedValue = "";
  // [LAW:dataflow-not-control-flow] enable()/disable() serialize through this
  // single slot rather than racing the hook-install/subscribe or
  // off/unsubscribe effects against refCount's synchronous increment —
  // without it, an enable() still mid-await could have its subscription
  // installed AFTER a racing disable() already tore it down, leaving the
  // relay subscribed forever with refCount stuck at 0.
  private pending: Promise<void> = Promise.resolve();
  private readonly onSubscriptionChanged = (
    msg: SubscriptionChangedMessage,
  ): void => {
    if (msg.name !== SUBSCRIPTION_NAME) return;
    void this.handleDelivery(msg.value);
  };

  constructor(
    private readonly client: TmuxConnection,
    private readonly emit: (msg: CrossSessionLayoutMessage) => void,
  ) {}

  /** Idempotent-in-effect: safe to call from any process at any time. */
  enable(): Promise<void> {
    this.refCount += 1;
    const shouldInstall = this.refCount === 1;
    this.pending = this.pending.then(async () => {
      if (!shouldInstall) return;
      await this.client.execute(installHookCommand());
      this.client.on("subscription-changed", this.onSubscriptionChanged);
      await subscribeRaw(
        this.client,
        SUBSCRIPTION_NAME,
        "",
        `#{${OPTION_NAME}}`,
      );
    });
    return this.pending;
  }

  /** Drops this relay's local subscription once the last local user is gone. The hook is never removed — see the class doc comment. */
  disable(): Promise<void> {
    if (this.refCount === 0) return this.pending;
    this.refCount -= 1;
    const shouldTearDown = this.refCount === 0;
    this.pending = this.pending.then(async () => {
      if (!shouldTearDown) return;
      this.client.off("subscription-changed", this.onSubscriptionChanged);
      await unsubscribe(this.client, SUBSCRIPTION_NAME);
    });
    return this.pending;
  }

  private async handleDelivery(value: string): Promise<void> {
    const remainder = diffAgainstLastProcessed(value, this.lastProcessedValue);
    const { entries, skips } = decodeEntries(remainder);
    this.lastProcessedValue = value;

    for (const skip of skips) {
      this.emit({ type: "cross-session-layout-decode-error", ...skip });
    }
    // Independent fetches — pipeline them rather than paying one full round
    // trip per entry serially during a same-tick multi-window burst. The
    // client's own FIFO correlates each execute() to its own response
    // regardless of issue order.
    await Promise.all(
      entries.map((entry) =>
        this.fetchAndEmit(entry.sessionId, entry.windowId),
      ),
    );

    // Freshness optimization only — not load-bearing for boundedness (the
    // hook's own append already self-caps). A skipped trim just means the
    // option grows a little longer before the next successful one.
    await this.client.execute(trimCommand(value)).catch(() => undefined);
  }

  private async fetchAndEmit(
    sessionId: number,
    windowId: number,
  ): Promise<void> {
    try {
      const response = await this.client.execute(fetchLayoutCommand(windowId));
      const line = response.output[0];
      // [LAW:no-silent-failure] An empty/malformed reply from a live window
      // is unexpected (unlike a vanished window, which rejects loudly below
      // and is handled in the catch) — report it rather than dropping the
      // entry with no signal at all.
      const [windowLayout, windowVisibleLayout, windowFlags] = (
        line ?? ""
      ).split("\x01");
      if (windowLayout === undefined || windowLayout === "") {
        this.emit({
          type: "cross-session-layout-fetch-failed",
          sessionId,
          windowId,
        });
        return;
      }
      this.emit({
        type: "cross-session-layout-change",
        sessionId,
        windowId,
        windowLayout,
        windowVisibleLayout: windowVisibleLayout ?? "",
        windowFlags: windowFlags ?? "",
      });
    } catch {
      this.emit({
        type: "cross-session-layout-fetch-failed",
        sessionId,
        windowId,
      });
    }
  }
}
