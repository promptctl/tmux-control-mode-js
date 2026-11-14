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
// entry, a vanished window, a hook another command removed or shadowed)
// emits a diagnostic rather than swallowing.

import type { TmuxConnection } from "./client.js";
import { subscribeRaw, unsubscribe } from "./commands/index.js";
import type { DeliveryQueue } from "./delivery-queue.js";
import { isConnectionGone, TmuxCommandError } from "./errors.js";
import { tmuxEscape } from "./protocol/encoder.js";
import { windowLayoutFields } from "./protocol/layout.js";
import type { SubscriptionChangedMessage } from "./protocol/types.js";
import {
  CROSS_SESSION_LAYOUT_SUBSCRIPTION_NAME as SUBSCRIPTION_NAME,
  type CrossSessionLayoutChangeMessage,
  type CrossSessionLayoutFetchFailedMessage,
  type CrossSessionLayoutMessage,
} from "./cross-session-layout-messages.js";

export type {
  CrossSessionLayoutChangeMessage,
  CrossSessionLayoutDecodeErrorMessage,
  CrossSessionLayoutFetchFailedMessage,
  CrossSessionLayoutHookRestoredMessage,
  CrossSessionLayoutMessage,
  CrossSessionLayoutOverrunMessage,
  CrossSessionLayoutRepairFailedMessage,
  CrossSessionLayoutUncoveredMessage,
} from "./cross-session-layout-messages.js";

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
const HOOK = `window-layout-changed[${RESERVED_HOOK_INDEX}]`;

const OPTION_NAME = "@ttcmjs-cross-session-layout";
const SEQ_OPTION_NAME = "@ttcmjs-cross-session-layout-seq";
/**
 * Bumped by whichever relay reinstalls a removed hook. Every relay
 * subscribes to it, so every relay — not only the one that repaired — learns
 * that changes went unrecorded.
 */
const EPOCH_OPTION_NAME = "@ttcmjs-cross-session-layout-epoch";

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
  return `set-hook -g ${HOOK} ${tmuxEscape(hookCommand())}`;
}

/** Reads the global entry alone: `<hook> <command>`, or `<hook> ` once removed. */
const SHOW_HOOK_COMMAND = `show-hooks -g ${HOOK}`;

/**
 * The epoch read as a number: digits, or `""` for text that isn't one — so a
 * foreign write to the option can never put a `|` into the subscription
 * value. [LAW:parse-dont-validate] tmux does the coercion.
 */
const EPOCH_FORMAT = `#{e|+:#{${EPOCH_OPTION_NAME}},0}`;

const BUMP_EPOCH_COMMAND = `set-option -gF ${EPOCH_OPTION_NAME} "#{e|+:${EPOCH_FORMAT},1}"`;

function installAndBumpCommand(): string {
  // One command list: tmux applies both or reports the one that failed, so
  // no relay can see the hook back without the epoch that announces it.
  return `${installHookCommand()} ; ${BUMP_EPOCH_COMMAND}`;
}

/**
 * Every window, server-wide, that the hook does not cover, as `@<wid>,`
 * entries. A hook name in a format reads the hook effective in that
 * context, so inside `#{W:}` it is empty for a window whose window-local
 * hook, or whose session's hook, replaces the global array — and for every
 * window once the global entry itself is gone — which only `show-hooks -g`
 * can tell apart from shadowing. `#,` because a bare comma inside `#{W:}`
 * separates its arguments. A window linked into several sessions appears
 * once per session; {@link decodeDelivery} reduces the list to a set.
 */
const UNCOVERED_FORMAT = `#{S:#{W:#{?#{${HOOK}},,#{window_id}#,}}}`;

const UNCOVERED_RE = /^(?:@\d+,)*$/;

/** The subscription's value: the epoch, `|`, the uncovered windows, `|`, then the buffer. */
const SUBSCRIPTION_FORMAT = `${EPOCH_FORMAT}|${UNCOVERED_FORMAT}|#{${OPTION_NAME}}`;

function readBaselineCommand(): string {
  return `display-message -p ${tmuxEscape(`#{${SEQ_OPTION_NAME}}|${EPOCH_FORMAT}`)}`;
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

export interface Coverage {
  /** The epoch option's text — `""` until a relay first repairs the hook. */
  readonly epoch: string;
  /** Uncovered window ids, ascending and distinct. */
  readonly uncovered: readonly number[];
}

/**
 * Split one delivery into its coverage and its buffer. `coverage` is `null`
 * when the head isn't the format's own output — tmux generates it, so a
 * mismatch means the value is not what this relay subscribed to.
 * [LAW:parse-dont-validate]
 */
export function decodeDelivery(value: string): {
  readonly coverage: Coverage | null;
  readonly buffer: string;
} {
  const m = /^(\d*)\|([^|]*)\|/.exec(value);
  if (m === null || !UNCOVERED_RE.test(m[2])) {
    const lastBar = value.lastIndexOf("|");
    return {
      coverage: null,
      buffer: lastBar === -1 ? "" : value.slice(lastBar + 1),
    };
  }
  const ids = [...m[2].matchAll(/@(\d+),/g)].map((w) => Number(w[1]));
  return {
    coverage: {
      epoch: m[1],
      uncovered: [...new Set(ids)].sort((a, b) => a - b),
    },
    buffer: value.slice(m[0].length),
  };
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

/** tmux's `%error` output for a refused command; any other error as text. */
function failureReason(err: unknown): string {
  return err instanceof TmuxCommandError
    ? err.response.output.join("\n")
    : String(err);
}

/** Both sides come from {@link decodeDelivery}: sorted and distinct. */
function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
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
  // The epoch last seen, and the uncovered set last reported — `null` until
  // this subscription's first delivery, which is always reported.
  private epoch = "";
  private reportedUncovered: readonly number[] | null = null;
  // A repair already waiting in the queue answers every delivery behind it.
  private repairQueued = false;
  // [LAW:dataflow-not-control-flow] enable()/disable() — and coverage
  // repair, so two deliveries never repair at once — serialize through
  // this slot, and each step reconciles `subscribed` toward `refCount > 0`
  // rather than acting on a decision taken before it waited — so racing
  // calls, and a step that failed, leave state the next step corrects.
  private queue: Promise<void> = Promise.resolve();
  private readonly onSubscriptionChanged = (
    msg: SubscriptionChangedMessage,
  ): void => {
    if (msg.name !== SUBSCRIPTION_NAME) return;
    // Heard as a delivery, so it is an entry point: its own step.
    void this.delivery.step(() => this.handleDelivery(msg.value));
  };

  // [LAW:single-enforcer] What the relay reports reaches listeners through
  //   the client's queue. Every segment that reports — an entry point, or the
  //   code after an await — runs as a step of it, so no listener runs inside
  //   the relay.
  constructor(
    private readonly client: TmuxConnection,
    private readonly delivery: DeliveryQueue,
    private readonly emit: (msg: CrossSessionLayoutMessage) => void,
  ) {}

  private report(msg: CrossSessionLayoutMessage): void {
    this.delivery.post(this.emit, msg);
  }

  /** Idempotent-in-effect: safe to call from any process at any time. Rejects, and counts for nothing, if the subscription could not be set up. */
  enable(): Promise<void> {
    this.refCount += 1;
    return this.serialize(async () => {
      const joined = this.subscribed;
      await this.delivery.settle(
        () => this.reconcile(),
        (reconciled) => {
          if (!reconciled.ok) {
            this.refCount -= 1;
            throw reconciled.error;
          }
          // A listener joining a live subscription would otherwise never hear
          // the current set: deliveries report only changes.
          if (joined && this.reportedUncovered !== null) {
            this.report({
              type: "cross-session-layout-uncovered",
              windowIds: this.reportedUncovered,
            });
          }
        },
      );
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
    await this.ensureHook("replace");
    // Baseline before subscribing: the buffer may hold hours of entries
    // from relays long gone, and none of them are news to this one.
    // Anything appended after this read has a higher seq and arrives in
    // the subscription's first delivery; likewise any later repair's epoch.
    const response = await this.client.execute(readBaselineCommand());
    // An unset counter reads as "" (no hook has fired yet); anything else
    // that isn't an integer would baseline at 0 and replay the backlog.
    const baseline = response.output[0] ?? "";
    const m = /^(\d*)\|(\d*)$/.exec(baseline);
    if (m === null) {
      throw new Error(
        `${SEQ_OPTION_NAME}|${EPOCH_OPTION_NAME} is not an integer pair: ${JSON.stringify(baseline)}`,
      );
    }
    this.lastSeq = Number(m[1]);
    this.epoch = m[2];
    this.reportedUncovered = null;
    this.client.on("subscription-changed", this.onSubscriptionChanged);
    try {
      await subscribeRaw(
        this.client,
        SUBSCRIPTION_NAME,
        "",
        SUBSCRIPTION_FORMAT,
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
    const delivery = decodeDelivery(value);
    if (delivery.coverage === null) {
      this.report({
        type: "cross-session-layout-decode-error",
        skippedBytes: value.length - delivery.buffer.length,
      });
    } else {
      this.reportCoverage(generation, delivery.coverage);
    }
    const { entries, skips } = decodeEntries(delivery.buffer);
    const plan = planDelivery(entries, this.lastSeq);
    this.lastSeq = plan.lastSeq;

    for (const skip of skips) {
      this.report({ type: "cross-session-layout-decode-error", ...skip });
    }
    if (plan.lostEntries > 0) {
      this.report({
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

  /**
   * Every relay reads the same epoch, so each one reports a repair any relay
   * made. Every delivery with uncovered windows is answered by checking the
   * global entry itself — not only a changed set, since clearing the global
   * entry leaves the set unchanged when every window was already shadowed,
   * and a failed check is retried on the next delivery. Windows the user's
   * own hooks shadow are reported, never overridden.
   */
  private reportCoverage(generation: number, coverage: Coverage): void {
    if (coverage.epoch !== this.epoch) {
      this.epoch = coverage.epoch;
      this.report({ type: "cross-session-layout-hook-restored" });
    }
    const { uncovered } = coverage;
    if (
      this.reportedUncovered === null ||
      !sameIds(uncovered, this.reportedUncovered)
    ) {
      this.reportedUncovered = uncovered;
      this.report({
        type: "cross-session-layout-uncovered",
        windowIds: uncovered,
      });
    }
    if (uncovered.length === 0 || this.repairQueued) return;
    this.repairQueued = true;
    // The caller of a repair is this delivery, which has nobody to reject
    // to; the step reports its own failures.
    void this.serialize(() => this.repair(generation));
  }

  private async repair(generation: number): Promise<void> {
    this.repairQueued = false;
    if (generation !== this.generation) return;
    await this.delivery.settle(
      () => this.ensureHook("if-missing"),
      (repaired) => {
        if (repaired.ok || isConnectionGone(repaired.error)) return;
        this.report({
          type: "cross-session-layout-repair-failed",
          reason: failureReason(repaired.error),
        });
      },
    );
  }

  /**
   * Bring the global entry back when it is gone, bumping the epoch so every
   * relay hears it. `"replace"` (on subscribe) also overwrites a present
   * entry, so a stale or foreign command at the reserved index is replaced;
   * a repair leaves a present entry alone, so a hook cleared between the
   * check and the install is found missing by the next delivery's check
   * rather than silently reinstalled. Two relays racing both bump: a
   * repeated hook-restored over-reports, which costs a re-read, never a
   * lost change.
   */
  private async ensureHook(mode: "replace" | "if-missing"): Promise<void> {
    const shown = await this.client.execute(SHOW_HOOK_COMMAND);
    const line = shown.output[0] ?? "";
    const present =
      line.startsWith(HOOK) && line.slice(HOOK.length).trim() !== "";
    if (!present) await this.client.execute(installAndBumpCommand());
    else if (mode === "replace")
      await this.client.execute(installHookCommand());
  }

  private async fetchAndEmit(
    generation: number,
    windowId: number,
  ): Promise<void> {
    await this.delivery.settle(
      () => this.fetch(windowId),
      (fetched) => {
        if (!fetched.ok) throw fetched.error;
        if (fetched.value !== null && generation === this.generation) {
          this.report(fetched.value);
        }
      },
    );
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
      if (isConnectionGone(err)) return null;
      return {
        type: "cross-session-layout-fetch-failed",
        windowId,
        reason: failureReason(err),
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
      ...windowLayoutFields(windowLayout, windowVisibleLayout, windowFlags),
    };
  }
}
