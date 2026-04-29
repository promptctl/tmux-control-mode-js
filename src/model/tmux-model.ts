// src/model/tmux-model.ts
// TmuxModel — reactive topology projection over a TmuxClient.
//
// Promotes the demo's DemoStore topology layer (examples/web-multiplexer/web/
// store.ts) into the library. The demo retains its UI policy (keymap engine,
// confirm modals, route helpers); the topology projection — subscription
// installation, list-* bootstrap, fast-path refreshes, snapshot rebuild,
// diff emission — moves here.
//
// Architectural laws applied:
//   - [LAW:one-source-of-truth] Per-tier `Map<id, Record>` is the ONE record
//     store. Subscription delivery, bootstrap, and the two fast-paths all
//     write through these maps; `rebuild()` reads from them.
//   - [LAW:single-enforcer] One subscription path per tier (`subscribeSessions`/
//     `subscribeWindows`/`subscribePanes`). Names are auto-allocated by
//     TmuxClient — two TmuxModel instances on one client never collide.
//   - [LAW:dataflow-not-control-flow] The "scoped vs full" delivery
//     distinction is a function parameter (a predicate that selects which
//     existing records to replace), not a separate code path. Same `apply`
//     pipeline runs every time; the predicate decides what gets touched.
//   - [LAW:no-mode-explosion] No "is this a bootstrap or a live update"
//     mode flag. The maps are always the truth; rebuilds are unconditional.

import type { TmuxClient } from "../client.js";
import type {
  ClientSessionChangedMessage,
  LayoutChangeMessage,
  SessionWindowChangedMessage,
  WindowPaneChangedMessage,
} from "../protocol/types.js";
import {
  EMPTY_SNAPSHOT,
  type PaneSnapshot,
  type SessionSnapshot,
  type TmuxDiff,
  type TmuxModelError,
  type TmuxModelErrorPhase,
  type TmuxSnapshot,
  type WindowSnapshot,
} from "./types.js";
import {
  PANE_FIELDS,
  PANE_LINE_FORMAT,
  SESSION_FIELDS,
  SESSION_LINE_FORMAT,
  WINDOW_FIELDS,
  WINDOW_LINE_FORMAT,
  parseListLines,
  parseNumberOrNull,
  parseTmuxId,
  type PaneRow,
  type SessionRow,
  type WindowRow,
} from "./format.js";
import {
  activePaneId,
  activeSessionId,
  activeWindowId,
  currentSession,
  currentWindow,
  paneLabels,
} from "./selectors.js";
import { computeDiff } from "./diff.js";

// ---------------------------------------------------------------------------
// Internal record types
//
// Records are id-keyed parsed shapes — one source of truth per tier. They
// look almost like the snapshot types, but with an extra "parent id" so
// the rebuild can re-parent without searching.
// ---------------------------------------------------------------------------

interface SessionRecord {
  readonly id: number;
  readonly name: string;
  readonly attached: boolean;
}

interface WindowRecord {
  readonly sessionId: number;
  readonly id: number;
  readonly index: number;
  readonly name: string;
  readonly active: boolean;
  readonly zoomed: boolean;
}

interface PaneRecord {
  readonly windowId: number;
  readonly id: number;
  readonly index: number;
  readonly active: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly title: string;
}

// ---------------------------------------------------------------------------
// Public options + event map
// ---------------------------------------------------------------------------

export interface TmuxModelOptions {
  /**
   * External abort signal — when triggered, the model disposes itself.
   * Useful when the model is owned by a React effect / Svelte cleanup
   * that already issues an `AbortController` on unmount.
   */
  readonly signal?: AbortSignal;
}

export interface TmuxModelEventMap {
  /** Fires once after the first snapshot rebuild that includes all three tiers. */
  readonly ready: undefined;
  /** Fires after every successful rebuild — even when the diff is empty. */
  readonly snapshot: TmuxSnapshot;
  /**
   * Fires after every successful rebuild with the diff between the previous
   * and new snapshot. The first emission carries every entity as `added`.
   */
  readonly change: TmuxDiff;
  /** Fires for any phase-tagged failure inside the model. */
  readonly error: TmuxModelError;
}

type Handler<T> = (event: T) => void;

interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// TmuxModel
// ---------------------------------------------------------------------------

export class TmuxModel {
  private readonly client: TmuxClient;

  // [LAW:one-source-of-truth] Three id-keyed record stores. Every mutation
  // path writes here; `rebuild()` is a pure function over the three maps.
  private readonly sessionRecords = new Map<number, SessionRecord>();
  private readonly windowRecords = new Map<number, WindowRecord>();
  private readonly paneRecords = new Map<number, PaneRecord>();

  // The single piece of per-client state subscriptions cannot deliver.
  private clientSessionId: number | null = null;

  private cachedSnapshot: TmuxSnapshot = EMPTY_SNAPSHOT;
  private prevSnapshot: TmuxSnapshot | null = null;

  // Track which tiers have received at least one delivery so we can fire
  // `ready` exactly once when all three are populated.
  private readonly tiersReceived = new Set<"sessions" | "windows" | "panes">();
  private readyEmitted = false;

  private disposed = false;

  // Per-event handler sets (typed externally, erased internally).
  private readonly listeners: {
    [K in keyof TmuxModelEventMap]?: Set<Handler<TmuxModelEventMap[K]>>;
  } = {};

  // Cleanups invoked on dispose. Subscription handles, client.off calls,
  // and any external abort listener all collect here.
  private readonly cleanups: Disposable[] = [];

  // Latches a single in-flight `refreshSession(sid)` per session id so a
  // burst of `session-window-changed` events doesn't fan out to N parallel
  // list-windows/list-panes calls. The new burst still gets refreshed
  // because the latched promise re-runs the lookup; the burst just
  // collapses to one round-trip.
  private readonly inFlightSessionRefresh = new Map<number, Promise<void>>();
  private readonly inFlightWindowDimRefresh = new Map<number, Promise<void>>();

  constructor(client: TmuxClient, opts?: TmuxModelOptions) {
    this.client = client;

    // [LAW:single-enforcer] Internal listener installation goes here only.
    this.installEventListeners();

    // External signal → dispose. No double-dispose because dispose() is
    // idempotent.
    if (opts?.signal !== undefined) {
      const signal = opts.signal;
      // [LAW:no-defensive-null-guards] If the signal is already aborted,
      // schedule dispose so the constructor still returns a usable
      // (immediately-disposed) instance rather than throwing.
      if (signal.aborted) {
        queueMicrotask(() => this.dispose());
      } else {
        const onAbort = () => this.dispose();
        signal.addEventListener("abort", onAbort, { once: true });
        this.cleanups.push({
          dispose: () => signal.removeEventListener("abort", onAbort),
        });
      }
    }

    // Kick off subscriptions + bootstrap. Errors are reported via the
    // `error` event; constructor never throws so the caller can `on('error')`
    // before any failure can be observed. Microtask defer ensures the
    // listener gets a chance to register.
    queueMicrotask(() => {
      void this.start();
    });
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** Latest snapshot. Returns the empty snapshot before any data arrives. */
  snapshot(): TmuxSnapshot {
    return this.cachedSnapshot;
  }

  /**
   * Fast-path refresh for one session: list-windows -t and list-panes -s -t
   * for that session, merging fresh records into the store and re-running
   * rebuild. Use after a user-initiated structural change to feel snappy
   * before the ~1 Hz subscription tick catches up.
   *
   * [LAW:single-enforcer] Same record store, same rebuild — no parallel
   * write path that could leave the snapshot stale.
   */
  refreshSession(sessionId: number): Promise<void> {
    const existing = this.inFlightSessionRefresh.get(sessionId);
    if (existing !== undefined) return existing;
    const p = this.runRefreshSession(sessionId).finally(() => {
      this.inFlightSessionRefresh.delete(sessionId);
    });
    this.inFlightSessionRefresh.set(sessionId, p);
    return p;
  }

  /**
   * Detach all listeners, unsubscribe from tmux, and discard the record
   * store. Idempotent; subsequent `%subscription-changed` deliveries are
   * dropped silently because the SubscriptionHandle.dispose() removes the
   * router entry on the TmuxClient before we run our cleanups here.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.cleanups) c.dispose();
    this.cleanups.length = 0;
    this.sessionRecords.clear();
    this.windowRecords.clear();
    this.paneRecords.clear();
  }

  // ---- Event surface ------------------------------------------------------

  on<K extends keyof TmuxModelEventMap>(
    event: K,
    handler: Handler<TmuxModelEventMap[K]>,
  ): Disposable {
    let set = this.listeners[event] as
      | Set<Handler<TmuxModelEventMap[K]>>
      | undefined;
    if (set === undefined) {
      set = new Set();
      this.listeners[event] = set as never;
    }
    set.add(handler);
    return {
      dispose: () => {
        const s = this.listeners[event] as
          | Set<Handler<TmuxModelEventMap[K]>>
          | undefined;
        s?.delete(handler);
      },
    };
  }

  off<K extends keyof TmuxModelEventMap>(
    event: K,
    handler: Handler<TmuxModelEventMap[K]>,
  ): void {
    const set = this.listeners[event] as
      | Set<Handler<TmuxModelEventMap[K]>>
      | undefined;
    set?.delete(handler);
  }

  // ---- Convenience selector delegates ------------------------------------
  //
  // [LAW:one-source-of-truth] Each method delegates to the same pure
  // selector so the two idioms (instance method, free function) cannot
  // drift. Consumers can pick whichever ergonomics they prefer.

  activeSessionId(): number | null {
    return activeSessionId(this.cachedSnapshot);
  }
  activeWindowId(): number | null {
    return activeWindowId(this.cachedSnapshot);
  }
  activePaneId(): number | null {
    return activePaneId(this.cachedSnapshot);
  }
  currentSession(): SessionSnapshot | null {
    return currentSession(this.cachedSnapshot);
  }
  currentWindow(): WindowSnapshot | null {
    return currentWindow(this.cachedSnapshot);
  }
  paneLabels(): Map<number, string> {
    return paneLabels(this.cachedSnapshot);
  }

  // -------------------------------------------------------------------------
  // Lifecycle internals
  // -------------------------------------------------------------------------

  private async start(): Promise<void> {
    if (this.disposed) return;
    await this.installSubscriptions();
    if (this.disposed) return;
    await this.bootstrap();
  }

  private async installSubscriptions(): Promise<void> {
    try {
      const [sessionsHandle, windowsHandle, panesHandle] = await Promise.all([
        this.client.subscribeSessions(SESSION_FIELDS, (rows) =>
          this.applyFullSessionRows(rows),
        ),
        this.client.subscribeWindows(WINDOW_FIELDS, (rows) =>
          this.applyFullWindowRows(rows),
        ),
        this.client.subscribePanes(PANE_FIELDS, (rows) =>
          this.applyFullPaneRows(rows),
        ),
      ]);
      // [LAW:single-enforcer] If we were disposed mid-await, eagerly tear
      // down the just-installed subscriptions instead of leaking them.
      if (this.disposed) {
        sessionsHandle.dispose();
        windowsHandle.dispose();
        panesHandle.dispose();
        return;
      }
      this.cleanups.push(sessionsHandle, windowsHandle, panesHandle);
    } catch (cause) {
      this.emitError("subscribe", cause);
    }
  }

  private async bootstrap(): Promise<void> {
    try {
      const [sessionsResp, windowsResp, panesResp] = await Promise.all([
        this.client.execute(`list-sessions -F ${SESSION_LINE_FORMAT}`),
        this.client.execute(`list-windows -a -F ${WINDOW_LINE_FORMAT}`),
        this.client.execute(`list-panes -a -F ${PANE_LINE_FORMAT}`),
      ]);
      if (this.disposed) return;

      // [LAW:dataflow-not-control-flow] Always apply through the same path
      // — `applyFullXRows` — whether the rows came from a subscription or
      // a list-* call. The transport doesn't matter; the rows do.
      this.applyFullSessionRows(parseListLines(sessionsResp.output, SESSION_FIELDS));
      this.applyFullWindowRows(parseListLines(windowsResp.output, WINDOW_FIELDS));
      this.applyFullPaneRows(parseListLines(panesResp.output, PANE_FIELDS));
    } catch (cause) {
      this.emitError("bootstrap", cause);
    }

    // Bootstrap clientSessionId. If `%client-session-changed` fires first,
    // its handler already populated us; this just covers the case where
    // tmux didn't fire it (or fired it before we attached our listener).
    try {
      const resp = await this.client.execute("display-message -p '#{session_id}'");
      if (this.disposed) return;
      if (resp.success && resp.output[0] !== undefined) {
        const parsed = parseTmuxId(resp.output[0]);
        if (parsed !== null && this.clientSessionId === null) {
          this.clientSessionId = parsed;
          this.rebuildAndEmit();
        }
      }
    } catch (cause) {
      this.emitError("bootstrap", cause);
    }
  }

  private installEventListeners(): void {
    // [LAW:single-enforcer] These are the ONLY tmux events the model reacts
    // to. Subscriptions handle the rest. See DemoStore docstring for the
    // intentional non-handling of session-window-changed et al — but we
    // still fast-path `refreshSession` on those because the ~1 Hz cadence
    // of subscriptions is too slow for user-visible latency.

    const onClientSessionChanged = (ev: ClientSessionChangedMessage): void => {
      if (this.disposed) return;
      this.clientSessionId = ev.sessionId;
      this.rebuildAndEmit();
      void this.refreshSession(ev.sessionId);
    };
    const onLayoutChange = (ev: LayoutChangeMessage): void => {
      if (this.disposed) return;
      void this.refreshWindowDimensions(ev.windowId);
    };
    const onSessionWindowChanged = (ev: SessionWindowChangedMessage): void => {
      if (this.disposed) return;
      void this.refreshSession(ev.sessionId);
    };
    const onWindowPaneChanged = (_ev: WindowPaneChangedMessage): void => {
      if (this.disposed) return;
      const sid = this.clientSessionId;
      if (sid !== null) void this.refreshSession(sid);
    };

    this.client.on("client-session-changed", onClientSessionChanged);
    this.client.on("layout-change", onLayoutChange);
    this.client.on("session-window-changed", onSessionWindowChanged);
    this.client.on("window-pane-changed", onWindowPaneChanged);

    this.cleanups.push({
      dispose: () => {
        this.client.off("client-session-changed", onClientSessionChanged);
        this.client.off("layout-change", onLayoutChange);
        this.client.off("session-window-changed", onSessionWindowChanged);
        this.client.off("window-pane-changed", onWindowPaneChanged);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Apply paths — every record-store mutation funnels through here.
  //
  // [LAW:single-enforcer] These five functions are the only writers of
  // sessionRecords / windowRecords / paneRecords. If a new mutation path
  // needs to exist, route it through one of these or add a new apply
  // helper next to them — never reach into the maps from elsewhere.
  // -------------------------------------------------------------------------

  private applyFullSessionRows(rows: readonly SessionRow[]): void {
    if (this.disposed) return;
    this.sessionRecords.clear();
    for (const row of rows) {
      const id = parseTmuxId(row.session_id);
      if (id === null) continue;
      this.sessionRecords.set(id, {
        id,
        name: row.session_name,
        attached: row.session_attached !== "0" && row.session_attached !== "",
      });
    }
    this.markTierReceived("sessions");
    this.rebuildAndEmit();
  }

  private applyFullWindowRows(rows: readonly WindowRow[]): void {
    if (this.disposed) return;
    this.windowRecords.clear();
    for (const row of rows) {
      this.upsertWindowRow(row);
    }
    this.markTierReceived("windows");
    this.rebuildAndEmit();
  }

  private applyFullPaneRows(rows: readonly PaneRow[]): void {
    if (this.disposed) return;
    this.paneRecords.clear();
    for (const row of rows) {
      this.upsertPaneRow(row);
    }
    this.markTierReceived("panes");
    this.rebuildAndEmit();
  }

  private applyScopedWindowRows(
    sessionId: number,
    rows: readonly WindowRow[],
  ): void {
    if (this.disposed) return;
    // Drop existing window records that belong to this session; the fresh
    // rows for this session replace them. Other sessions' windows are
    // untouched.
    for (const [id, rec] of this.windowRecords) {
      if (rec.sessionId === sessionId) this.windowRecords.delete(id);
    }
    for (const row of rows) {
      this.upsertWindowRow(row);
    }
    this.rebuildAndEmit();
  }

  private applyScopedPaneRows(
    windowIds: ReadonlySet<number>,
    rows: readonly PaneRow[],
  ): void {
    if (this.disposed) return;
    // Drop existing pane records that belong to any of the named windows;
    // fresh rows replace them. Panes in other windows are untouched.
    for (const [id, rec] of this.paneRecords) {
      if (windowIds.has(rec.windowId)) this.paneRecords.delete(id);
    }
    for (const row of rows) {
      this.upsertPaneRow(row);
    }
    this.rebuildAndEmit();
  }

  private upsertWindowRow(row: WindowRow): void {
    const sessionId = parseTmuxId(row.session_id);
    const id = parseTmuxId(row.window_id);
    if (sessionId === null || id === null) return;
    const index = parseInt(row.window_index, 10);
    this.windowRecords.set(id, {
      sessionId,
      id,
      index: Number.isFinite(index) ? index : 0,
      name: row.window_name,
      active: row.window_active === "1",
      zoomed: row.window_zoomed_flag === "1",
    });
  }

  private upsertPaneRow(row: PaneRow): void {
    const windowId = parseTmuxId(row.window_id);
    const id = parseTmuxId(row.pane_id);
    if (windowId === null || id === null) return;
    const index = parseInt(row.pane_index, 10);
    this.paneRecords.set(id, {
      windowId,
      id,
      index: Number.isFinite(index) ? index : 0,
      active: row.pane_active === "1",
      width: parseNumberOrNull(row.pane_width),
      height: parseNumberOrNull(row.pane_height),
      title: row.pane_title,
    });
  }

  // -------------------------------------------------------------------------
  // Fast-path internals
  // -------------------------------------------------------------------------

  private async runRefreshSession(sessionId: number): Promise<void> {
    if (this.disposed) return;
    try {
      const [windowsResp, panesResp] = await Promise.all([
        this.client.execute(
          `list-windows -t $${sessionId} -F ${WINDOW_LINE_FORMAT}`,
        ),
        this.client.execute(
          `list-panes -s -t $${sessionId} -F ${PANE_LINE_FORMAT}`,
        ),
      ]);
      if (this.disposed) return;
      const windowRows = parseListLines(windowsResp.output, WINDOW_FIELDS);
      const paneRows = parseListLines(panesResp.output, PANE_FIELDS);
      const freshWindowIds = new Set<number>();
      for (const row of windowRows) {
        const id = parseTmuxId(row.window_id);
        if (id !== null) freshWindowIds.add(id);
      }
      this.applyScopedWindowRows(sessionId, windowRows);
      this.applyScopedPaneRows(freshWindowIds, paneRows);
    } catch (cause) {
      // Subscriptions catch up at ~1 Hz; surface the error for observability
      // but do not propagate. A rejected list-* on a torn-down session is
      // expected during a kill-session race.
      this.emitError("refresh-session", cause);
    }
  }

  private refreshWindowDimensions(windowId: number): Promise<void> {
    const existing = this.inFlightWindowDimRefresh.get(windowId);
    if (existing !== undefined) return existing;
    const p = this.runRefreshWindowDimensions(windowId).finally(() => {
      this.inFlightWindowDimRefresh.delete(windowId);
    });
    this.inFlightWindowDimRefresh.set(windowId, p);
    return p;
  }

  private async runRefreshWindowDimensions(windowId: number): Promise<void> {
    if (this.disposed) return;
    try {
      // [LAW:dataflow-not-control-flow] Use the canonical pane format so
      // `applyScopedPaneRows` sees the same shape as a full delivery —
      // the demo's bespoke 3-field "%pid|w|h" format would be a second
      // wire shape with its own parser. One format, one parser.
      const resp = await this.client.execute(
        `list-panes -t @${windowId} -F ${PANE_LINE_FORMAT}`,
      );
      if (this.disposed) return;
      // list-panes -t @id includes window_id in each row, so the resulting
      // PaneRows are valid PaneRow records.
      const rows = parseListLines(resp.output, PANE_FIELDS);
      this.applyScopedPaneRows(new Set([windowId]), rows);
    } catch (cause) {
      this.emitError("refresh-dims", cause);
    }
  }

  // -------------------------------------------------------------------------
  // Rebuild + emit
  // -------------------------------------------------------------------------

  private rebuildAndEmit(): void {
    if (this.disposed) return;
    const next = this.rebuildSnapshot();
    const diff = computeDiff(this.prevSnapshot, next);
    this.prevSnapshot = next;
    this.cachedSnapshot = next;

    this.emit("snapshot", next);
    this.emit("change", diff);

    // [LAW:dataflow-not-control-flow] `ready` is the latching condition
     // "snapshot is fully populated" — three topology tiers AND the
     // clientSessionId. Without that fourth, `model.activeSessionId()` would
     // return null at ready time, which is a worse contract than waiting
     // an extra round-trip for `display-message` to land.
    if (
      !this.readyEmitted &&
      this.tiersReceived.has("sessions") &&
      this.tiersReceived.has("windows") &&
      this.tiersReceived.has("panes") &&
      this.clientSessionId !== null
    ) {
      this.readyEmitted = true;
      this.emit("ready", undefined);
    }
  }

  private rebuildSnapshot(): TmuxSnapshot {
    // [LAW:dataflow-not-control-flow] Build child tier first, then the
    // parent. Each parent grabs its children from a precomputed Map keyed
    // by parent id — no nested lookups, no quadratic re-walks.
    const panesByWindow = new Map<number, PaneSnapshot[]>();
    for (const rec of this.paneRecords.values()) {
      const list = panesByWindow.get(rec.windowId) ?? [];
      list.push({
        id: rec.id,
        index: rec.index,
        active: rec.active,
        title: rec.title,
        width: rec.width,
        height: rec.height,
      });
      panesByWindow.set(rec.windowId, list);
    }
    for (const list of panesByWindow.values()) {
      list.sort((a, b) => a.index - b.index);
    }

    const windowsBySession = new Map<number, WindowSnapshot[]>();
    for (const rec of this.windowRecords.values()) {
      const list = windowsBySession.get(rec.sessionId) ?? [];
      list.push({
        id: rec.id,
        index: rec.index,
        name: rec.name,
        active: rec.active,
        zoomed: rec.zoomed,
        panes: panesByWindow.get(rec.id) ?? [],
      });
      windowsBySession.set(rec.sessionId, list);
    }
    for (const list of windowsBySession.values()) {
      list.sort((a, b) => a.index - b.index);
    }

    const sessions: SessionSnapshot[] = [];
    for (const rec of this.sessionRecords.values()) {
      sessions.push({
        id: rec.id,
        name: rec.name,
        attached: rec.attached,
        windows: windowsBySession.get(rec.id) ?? [],
      });
    }
    sessions.sort((a, b) => a.id - b.id);

    return { sessions, clientSessionId: this.clientSessionId };
  }

  private markTierReceived(tier: "sessions" | "windows" | "panes"): void {
    this.tiersReceived.add(tier);
  }

  private emit<K extends keyof TmuxModelEventMap>(
    event: K,
    payload: TmuxModelEventMap[K],
  ): void {
    const set = this.listeners[event] as
      | Set<Handler<TmuxModelEventMap[K]>>
      | undefined;
    if (set === undefined) return;
    for (const handler of set) handler(payload);
  }

  private emitError(phase: TmuxModelErrorPhase, cause: unknown): void {
    this.emit("error", { phase, cause });
  }
}

