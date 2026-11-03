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
import {
  TmuxCommandError,
  TransportClosedError,
  TransportSendError,
} from "./errors.js";
import { tmuxEscape } from "./protocol/encoder.js";
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
 * that only wants the gap this relay exists for filters on `windowId`
 * against the windows of its own attached session — not on `sessionId`,
 * which is the one session tmux resolves the window in at fetch time (the
 * one `windowFlags` describes) and, for a window linked into several
 * sessions, need not be the attached one. `windowLayout`/
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
 * tmux refused the follow-up fetch for a window whose layout changed —
 * most likely the window closed between the hook firing and this
 * ~1s-delayed subscription delivery. Nothing to report (no layout exists
 * for a window that's gone); surfaced rather than left as a silently
 * dropped entry. A fetch cut off by the connection closing emits nothing:
 * the client's own `connection-state` event already reports that.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutFetchFailedMessage {
  readonly type: "cross-session-layout-fetch-failed";
  readonly windowId: number;
  /** tmux's `%error` output for the fetch. */
  readonly reason: string;
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
 * `<seq>:@<wid>,` — about 20 bytes with both numbers at 8–10 digits — so
 * 4096 holds about 200 entries: a relay only loses entries
 * if more than that many layout changes land within one ~1s subscription
 * interval, and then it says so (`cross-session-layout-overrun`).
 */
const CAP = 4096;

const ENTRY_RE = /^(\d+):@(\d+),/;

/**
 * The hook: bump the server-wide sequence counter, then append
 * `<seq>:<window>,` (never the layout or session — both are fetched
 * afterwards, see {@link fetchLayoutCommand}), truncated to the last `CAP` bytes. tmux runs the two
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
    `"#{=-${CAP}:#{${OPTION_NAME}}#{${SEQ_OPTION_NAME}}:#{window_id},}"`
  );
}

function installHookCommand(): string {
  // set-hook takes hook-name + exactly one command argument, so the whole
  // command list goes in as a single tmux-parsed token.
  return `set-hook -g window-layout-changed[${RESERVED_HOOK_INDEX}] ${tmuxEscape(hookCommand())}`;
}

function readSeqCommand(): string {
  return `display-message -p ${tmuxEscape(`#{${SEQ_OPTION_NAME}}`)}`;
}

/**
 * Targets the window alone and reads back the session tmux resolves it in,
 * so `sessionId` and the per-session `#{window_flags}` always describe the
 * same session — and a window linked into a session that has since been
 * killed is still found through the sessions it remains in. Tab-separated
 * like the list formats in protocol/encoder.ts; no field can contain a tab.
 */
function fetchLayoutCommand(windowId: number): string {
  return `display-message -p -t @${windowId} ${tmuxEscape(
    "#{session_id}\t#{window_layout}\t#{window_visible_layout}\t#{window_flags}",
  )}`;
}

// ---------------------------------------------------------------------------
// Decoding — pure, no I/O, independently testable.
// ---------------------------------------------------------------------------

export interface DecodedEntry {
  readonly seq: number;
  readonly windowId: number;
}

export interface DecodeResult {
  readonly entries: readonly DecodedEntry[];
  readonly skips: readonly { readonly skippedBytes: number }[];
}

/**
 * Decode every `<seq>:@<wid>,` entry in `value`. When `value` is at `CAP`
 * length the hook's truncation may have sheared its first entry — and a
 * sheared entry can still look well-formed (`12:@4,` → `2:@4,`),
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
      entries.push({ seq: Number(m[1]), windowId: Number(m[2]) });
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
  readonly windowIds: readonly number[];
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
  if (fresh.length === 0) return { windowIds: [], lostEntries: 0, lastSeq };
  const seqs = fresh.map((e) => e.seq);
  return {
    windowIds: [...new Set(fresh.map((e) => e.windowId))],
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
    // An unset counter reads as "" (no hook has fired yet); anything else
    // that isn't an integer would baseline at 0 and replay the backlog.
    const seq = response.output[0] ?? "";
    if (!/^\d*$/.test(seq)) {
      throw new Error(
        `${SEQ_OPTION_NAME} is not an integer: ${JSON.stringify(seq)}`,
      );
    }
    this.lastSeq = Number(seq);
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
      plan.windowIds.map((windowId) => this.fetchAndEmit(generation, windowId)),
    );
  }

  private async fetchAndEmit(
    generation: number,
    windowId: number,
  ): Promise<void> {
    const message = await this.fetch(windowId);
    if (message !== null && generation === this.generation) this.emit(message);
  }

  /** `null` when the connection closed mid-fetch — see {@link CrossSessionLayoutFetchFailedMessage}. */
  private async fetch(
    windowId: number,
  ): Promise<
    | CrossSessionLayoutChangeMessage
    | CrossSessionLayoutFetchFailedMessage
    | null
  > {
    let line: string;
    try {
      const response = await this.client.execute(fetchLayoutCommand(windowId));
      line = response.output[0] ?? "";
    } catch (err) {
      if (
        err instanceof TransportClosedError ||
        err instanceof TransportSendError
      ) {
        return null;
      }
      return {
        type: "cross-session-layout-fetch-failed",
        windowId,
        reason:
          err instanceof TmuxCommandError
            ? err.response.output.join("\n")
            : String(err),
      };
    }
    // [LAW:no-silent-failure] A reply that doesn't match the requested
    // format is unexpected from a live window — report it rather than
    // emitting a half-parsed layout.
    const [session, windowLayout, windowVisibleLayout, windowFlags, extra] =
      line.split("\t");
    const sessionMatch = /^\$(\d+)$/.exec(session ?? "");
    if (
      sessionMatch === null ||
      !windowLayout ||
      windowVisibleLayout === undefined ||
      windowFlags === undefined ||
      extra !== undefined
    ) {
      return {
        type: "cross-session-layout-fetch-failed",
        windowId,
        reason: `unexpected reply: ${JSON.stringify(line)}`,
      };
    }
    return {
      type: "cross-session-layout-change",
      sessionId: Number(sessionMatch[1]),
      windowId,
      windowLayout,
      windowVisibleLayout,
      windowFlags,
    };
  }
}
