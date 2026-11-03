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
 * where it expected an entry to start — something other than this
 * library's hook wrote the option. The malformed span was skipped (up to
 * and including the next comma), not misinterpreted as a real identity.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutDecodeErrorMessage {
  readonly type: "cross-session-layout-decode-error";
  readonly skippedBytes: number;
}

/**
 * Layout changes happened faster than this relay drained them: the hook's
 * `CAP` truncation discarded `lostEntries` entries this relay had not yet
 * seen, so their windows' changes were never fetched. A consumer that needs
 * completeness re-reads every window's layout on this event.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutOverrunMessage {
  readonly type: "cross-session-layout-overrun";
  readonly lostEntries: number;
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
  | CrossSessionLayoutOverrunMessage
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
const SEQ_OPTION_NAME = "@ttcmjs-cross-session-layout-seq";
const SUBSCRIPTION_NAME = "ttcmjs-cross-session-layout";

/**
 * Bytes retained in the relayed option, enforced by the hook's own append
 * (so growth never depends on any relay being alive). One entry is
 * `<seq>:$<sid>:@<wid>,` — about 30 bytes with every number at 8–10
 * digits — so 4096 holds well over 100 entries: a relay only loses entries
 * if more than that many layout changes land within one ~1s subscription
 * interval, and then it says so (`cross-session-layout-overrun`).
 */
const CAP = 4096;

const ENTRY_RE = /^(\d+):\$(\d+):@(\d+),/;

/**
 * The hook: bump the server-wide sequence counter, then append
 * `<seq>:<session>:<window>,` (never the layout string itself — it is
 * fetched afterwards), truncated to the last `CAP` bytes. tmux runs the two
 * commands of one hook back to back, so the second expands the counter the
 * first just set; an unset counter expands `#{e|+:,1}` to 1.
 *
 * [LAW:one-source-of-truth] The buffer is append-only and no relay ever
 * writes it: each relay tracks the highest `seq` it has handled, so any
 * number of relays — in this process or another — read the same buffer
 * without consuming each other's entries. `-F` is required: `set-option -g`
 * without it stores the literal, unexpanded `#{...}` text.
 */
function hookCommand(): string {
  return (
    `set-option -gF ${SEQ_OPTION_NAME} "#{e|+:#{${SEQ_OPTION_NAME}},1}" ; ` +
    `set-option -gF ${OPTION_NAME} ` +
    `"#{=-${CAP}:#{${OPTION_NAME}}#{${SEQ_OPTION_NAME}}:#{session_id}:#{window_id},}"`
  );
}

function installHookCommand(): string {
  // set-hook takes hook-name + exactly one command argument — the inner
  // command list (itself containing double-quoted format strings) must be
  // wrapped as a single tmux-parsed token. tmux's command-line tokenizer
  // supports nested single/double quoting the way a shell does.
  return `set-hook -g window-layout-changed[${RESERVED_HOOK_INDEX}] '${hookCommand()}'`;
}

function readSeqCommand(): string {
  return `display-message -p "#{${SEQ_OPTION_NAME}}"`;
}

/**
 * Targets `$session:@window`, not bare `@window`: a window linked into more
 * than one session has a per-session `#{window_flags}` (current/last), and
 * the flags must be the ones for the session the hook recorded.
 */
function fetchLayoutCommand(sessionId: number, windowId: number): string {
  return `display-message -p -t '$${sessionId}:@${windowId}' "#{window_layout}\x01#{window_visible_layout}\x01#{window_flags}"`;
}

// ---------------------------------------------------------------------------
// Decoding — pure, no I/O, independently testable.
// ---------------------------------------------------------------------------

export interface DecodedEntry {
  readonly seq: number;
  readonly sessionId: number;
  readonly windowId: number;
}

export interface DecodeResult {
  readonly entries: readonly DecodedEntry[];
  readonly skips: readonly { readonly skippedBytes: number }[];
}

/**
 * Decode every `<seq>:$<sid>:@<wid>,` entry in `value`. When `value` is at
 * `CAP` length the hook's truncation may have sheared its first entry —
 * and a sheared entry can still look well-formed (`12:$3:@4,` → `2:$3:@4,`),
 * so it is dropped unread rather than trusted; a real entry lost that way
 * shows up as a `seq` gap, which {@link planDelivery} reports. Any other
 * non-match is foreign text: skip to the next `,` and record the skip.
 * [LAW:parse-don't-validate]
 */
export function decodeEntries(value: string): DecodeResult {
  const entries: DecodedEntry[] = [];
  const skips: { skippedBytes: number }[] = [];
  let cursor = value;
  if (value.length >= CAP) {
    const commaIdx = cursor.indexOf(",");
    cursor = commaIdx === -1 ? "" : cursor.slice(commaIdx + 1);
  }
  while (cursor.length > 0) {
    const m = ENTRY_RE.exec(cursor);
    if (m) {
      entries.push({
        seq: Number(m[1]),
        sessionId: Number(m[2]),
        windowId: Number(m[3]),
      });
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

export interface DeliveryPlan {
  /** Distinct windows changed since `lastSeq`, in first-seen order. */
  readonly windows: readonly {
    readonly sessionId: number;
    readonly windowId: number;
  }[];
  /** Entries newer than `lastSeq` that truncation discarded unseen. */
  readonly lostEntries: number;
  readonly lastSeq: number;
}

/**
 * What one delivery means to a relay that has handled everything up to
 * `lastSeq`: the entries newer than that (deduplicated — two changes to one
 * window need one fetch, since the fetch reads its current layout), how many
 * newer entries were lost before this relay saw them, and the new high-water
 * mark.
 */
export function planDelivery(
  entries: readonly DecodedEntry[],
  lastSeq: number,
): DeliveryPlan {
  const fresh = entries.filter((e) => e.seq > lastSeq);
  if (fresh.length === 0) return { windows: [], lostEntries: 0, lastSeq };
  const seen = new Set<string>();
  const windows: { sessionId: number; windowId: number }[] = [];
  for (const e of fresh) {
    const key = `${e.sessionId}:${e.windowId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({ sessionId: e.sessionId, windowId: e.windowId });
  }
  const seqs = fresh.map((e) => e.seq);
  return {
    windows,
    lostEntries: Math.min(...seqs) - lastSeq - 1,
    lastSeq: Math.max(...seqs),
  };
}

// ---------------------------------------------------------------------------
// CrossSessionLayoutRelay
// ---------------------------------------------------------------------------

/**
 * Per-`TmuxClient` relay. Ref-counted `enable`/`disable` so more than one
 * local listener can ask for this coverage without duplicate subscriptions;
 * the global hook, once installed, is intentionally never torn down —
 * cross-process ref-counting has no safe shared counter, and the hook's own
 * command is self-capping, so leaving it in place is simpler and strictly
 * safer than a teardown that could race another process's coverage away.
 */
export class CrossSessionLayoutRelay {
  private refCount = 0;
  private subscribed = false;
  private lastSeq = 0;
  // Bumped on every teardown; a delivery still fetching when its
  // subscription is torn down sees a different generation and emits nothing.
  private generation = 0;
  // [LAW:dataflow-not-control-flow] enable()/disable() serialize through
  // this slot, and each step reconciles `subscribed` toward `refCount > 0`
  // rather than acting on a decision taken before it waited — so racing
  // calls, and a step that failed, leave state the next step corrects.
  private queue: Promise<void> = Promise.resolve();
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

  /** Idempotent-in-effect: safe to call from any process at any time. Rejects, and counts for nothing, if the subscription could not be set up. */
  enable(): Promise<void> {
    this.refCount += 1;
    return this.serialize(async () => {
      try {
        await this.reconcile();
      } catch (err) {
        this.refCount -= 1;
        throw err;
      }
    });
  }

  /** Drops this relay's local subscription once the last local user is gone. The hook is never removed — see the class doc comment. */
  disable(): Promise<void> {
    if (this.refCount === 0) return this.queue;
    this.refCount -= 1;
    return this.serialize(() => this.reconcile());
  }

  private serialize(step: () => Promise<void>): Promise<void> {
    const run = this.queue.then(step);
    // The caller receives `run`'s rejection; the queue only orders steps,
    // so a failed step must not poison every step behind it.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reconcile(): Promise<void> {
    const wanted = this.refCount > 0;
    if (wanted && !this.subscribed) await this.subscribe();
    else if (!wanted && this.subscribed) await this.unsubscribe();
  }

  private async subscribe(): Promise<void> {
    await this.client.execute(installHookCommand());
    // Baseline before subscribing: the buffer may hold hours of entries
    // from relays long gone, and none of them are news to this one.
    // Anything appended after this read has a higher seq and arrives in
    // the subscription's first delivery.
    const response = await this.client.execute(readSeqCommand());
    this.lastSeq = Number(response.output[0] ?? "") || 0;
    this.client.on("subscription-changed", this.onSubscriptionChanged);
    try {
      await subscribeRaw(
        this.client,
        SUBSCRIPTION_NAME,
        "",
        `#{${OPTION_NAME}}`,
      );
    } catch (err) {
      this.client.off("subscription-changed", this.onSubscriptionChanged);
      throw err;
    }
    this.subscribed = true;
  }

  private async unsubscribe(): Promise<void> {
    this.subscribed = false;
    this.generation += 1;
    this.client.off("subscription-changed", this.onSubscriptionChanged);
    await unsubscribe(this.client, SUBSCRIPTION_NAME);
  }

  private async handleDelivery(value: string): Promise<void> {
    const generation = this.generation;
    const { entries, skips } = decodeEntries(value);
    const plan = planDelivery(entries, this.lastSeq);
    this.lastSeq = plan.lastSeq;

    for (const skip of skips) {
      this.emit({ type: "cross-session-layout-decode-error", ...skip });
    }
    if (plan.lostEntries > 0) {
      this.emit({
        type: "cross-session-layout-overrun",
        lostEntries: plan.lostEntries,
      });
    }
    // Independent fetches — pipeline them rather than paying one full round
    // trip per window serially during a same-tick multi-window burst. The
    // client's own FIFO correlates each execute() to its own response
    // regardless of issue order.
    await Promise.all(
      plan.windows.map((w) =>
        this.fetchAndEmit(generation, w.sessionId, w.windowId),
      ),
    );
  }

  private async fetchAndEmit(
    generation: number,
    sessionId: number,
    windowId: number,
  ): Promise<void> {
    const message = await this.fetch(sessionId, windowId);
    if (generation === this.generation) this.emit(message);
  }

  private async fetch(
    sessionId: number,
    windowId: number,
  ): Promise<
    CrossSessionLayoutChangeMessage | CrossSessionLayoutFetchFailedMessage
  > {
    const failed = {
      type: "cross-session-layout-fetch-failed",
      sessionId,
      windowId,
    } as const;
    try {
      const response = await this.client.execute(
        fetchLayoutCommand(sessionId, windowId),
      );
      // [LAW:no-silent-failure] An empty/malformed reply from a live window
      // is unexpected (unlike a vanished window, which rejects below) —
      // report it rather than dropping the entry with no signal at all.
      const [windowLayout, windowVisibleLayout, windowFlags] = (
        response.output[0] ?? ""
      ).split("\x01");
      if (windowLayout === undefined || windowLayout === "") return failed;
      return {
        type: "cross-session-layout-change",
        sessionId,
        windowId,
        windowLayout,
        windowVisibleLayout: windowVisibleLayout ?? "",
        windowFlags: windowFlags ?? "",
      };
    } catch {
      return failed;
    }
  }
}
