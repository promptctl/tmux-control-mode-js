// src/window-terminal/engine/window-engine.ts
//
// `WindowEngine` — one tmux window followed over one connection: it puts the
// window's facts together on arrival, keeps them current from tmux's
// notifications, runs one `PaneStream` per pane with a surface for each, and
// publishes the terminal's state. DOM-free; the renderer is a port.
//
// [LAW:effects-at-boundaries] Every tmux effect of the window lives here; the
//   facts, the view and the phase come from the pure `window-model.ts`.
// [LAW:single-enforcer] The connection's state is the one signal for "the
//   facts may be behind": leaving `ready` marks them unsynced, reaching `ready`
//   while unsynced bootstraps. The engine does not listen to `reconnected`;
//   each `PaneStream` does, for its own picture.
// [LAW:no-silent-failure] A tmux command that fails while tmux is reachable
//   reaches `onError`; a lost connection is the `stale` phase, never an error.

import type { TmuxEventMap } from "../../browser.js";
import {
  TmuxReplyFormatError,
  isConnectionGone,
  listPanes,
} from "../../browser.js";
import { latin1ToText } from "../../protocol/byte-codec.js";
import {
  paneIdOf,
  paneNumber,
  windowNumber,
  type PaneId,
  type WindowId,
} from "../ids.js";
import {
  ALL_WINDOWS_COMMAND,
  ATTACHED_WINDOWS_COMMAND,
  FLAGS_FORMAT,
  PANE_META_FORMAT,
  parseFlags,
  parseMembership,
  parsePaneMeta,
  parseSnapshot,
  snapshotCommand,
} from "./bootstrap.js";
import { PaneStream, type TerminalConnection } from "./pane-stream.js";
import { rethrowUnlessUnsubscribed } from "./teardown.js";
import type { TerminalSink } from "./terminal-sink.js";
import { uniqueToken } from "./token.js";
import {
  deriveView,
  factsFromSnapshot,
  paneDiff,
  phaseFor,
  reduceWindow,
  type FocusPolicy,
  type Sync,
  type WindowEvent,
  type WindowFacts,
  type WindowTerminalError,
  type WindowTerminalState,
  type WindowView,
} from "./window-model.js";

/** What the renderer gives a pane: where its picture goes, and its teardown. */
export interface PaneSurface {
  readonly sink: TerminalSink;
  dispose(): void;
}

/**
 * The renderer, as the engine sees it. `keys` sends what is typed into the
 * pane's surface to that pane, and to no other.
 */
export interface PaneSurfaces {
  create(pane: PaneId, keys: (data: string) => void): PaneSurface;
}

export interface WindowEngineOptions {
  readonly connection: TerminalConnection;
  readonly windowId: WindowId;
  /** Scrollback lines captured per pane on arrival. */
  readonly history: number;
  readonly surfaces: PaneSurfaces;
  readonly now: () => number;
}

interface PaneSlot {
  readonly stream: PaneStream;
  readonly surface: PaneSurface;
  readonly offState: () => void;
}

type Listener<T> = (value: T) => void;

export class WindowEngine {
  private readonly connection: TerminalConnection;
  private readonly windowId: WindowId;
  private readonly windowN: number;
  private readonly history: number;
  private readonly surfaces: PaneSurfaces;
  private readonly now: () => number;
  private readonly flagsName: string;
  private readonly metaName: string;

  private current: WindowTerminalState = { phase: "connecting" };
  private sync: Sync = { kind: "unsynced" };
  private facts: WindowFacts | null = null;
  private policy: FocusPolicy = { kind: "follow-active" };
  private readonly panes = new Map<PaneId, PaneSlot>();
  // [LAW:stale-rejection-guard-identity] A bootstrap's replies apply only while
  //   this still holds the number it started with; leaving `ready`, a new
  //   bootstrap, `gone` and `dispose` all move it on.
  private epoch = 0;
  // Window events since the running bootstrap began, replayed over its
  // snapshot: each carries a whole value, so replaying from any point before
  // the snapshot ends at tmux's latest. `null` when no bootstrap runs.
  private queue: WindowEvent[] | null = null;
  private subscribed = false;
  private ended = false;

  private readonly stateListeners = new Set<Listener<WindowTerminalState>>();
  private readonly errorListeners = new Set<Listener<WindowTerminalError>>();

  private readonly onConnectionState = (
    ev: TmuxEventMap["connection-state"],
  ): void => {
    if (ev.state.status === "ready") {
      if (this.sync.kind === "unsynced") this.bootstrap();
    } else if (this.sync.kind !== "gone") {
      this.epoch++;
      this.queue = null;
      this.sync = { kind: "unsynced" };
    }
    this.publish();
  };
  private readonly onLayout = (ev: TmuxEventMap["layout-change"]): void => {
    if (ev.windowId === this.windowN)
      this.apply({ kind: "layout", layout: ev });
  };
  private readonly onActive = (
    ev: TmuxEventMap["window-pane-changed"],
  ): void => {
    if (ev.windowId === this.windowN) {
      this.apply({ kind: "active", pane: paneIdOf(ev.paneId) });
    }
  };
  private readonly onRenamed = (
    ev:
      | TmuxEventMap["window-renamed"]
      | TmuxEventMap["unlinked-window-renamed"],
  ): void => {
    if (ev.windowId === this.windowN) {
      this.apply({ kind: "renamed", name: latin1ToText(ev.name) });
    }
  };
  private readonly onClosed = (
    ev: TmuxEventMap["window-close"] | TmuxEventMap["unlinked-window-close"],
  ): void => {
    // Closed, or unlinked from this client's session: the bootstrap's
    // membership read tells which.
    if (ev.windowId === this.windowN) this.rebootstrap();
  };
  private readonly onSessionChanged = (): void => this.rebootstrap();
  private readonly onSubscription = (
    ev: TmuxEventMap["subscription-changed"],
  ): void => {
    if (ev.name === this.flagsName) {
      const flags = parseFlags(ev.value);
      if (flags === null) this.malformedValue(ev.value);
      else this.apply({ kind: "flags", flags });
    } else if (ev.name === this.metaName && ev.windowId === this.windowN) {
      const meta = parsePaneMeta(ev.value);
      if (meta === null) this.malformedValue(ev.value);
      else this.apply({ kind: "pane-meta", pane: paneIdOf(ev.paneId), meta });
    }
  };

  constructor(opts: WindowEngineOptions) {
    this.connection = opts.connection;
    this.windowId = opts.windowId;
    this.windowN = windowNumber(opts.windowId);
    this.history = opts.history;
    this.surfaces = opts.surfaces;
    this.now = opts.now;
    // [LAW:one-source-of-truth] Names unique to this engine: tmux keys
    //   subscriptions by name per control client, and every page behind one
    //   bridge shares that client.
    const token = uniqueToken();
    this.flagsName = `wt-${token}-flags-${opts.windowId}`;
    this.metaName = `wt-${token}-panes-${opts.windowId}`;

    const c = this.connection;
    c.on("connection-state", this.onConnectionState);
    c.on("layout-change", this.onLayout);
    c.on("window-pane-changed", this.onActive);
    c.on("window-renamed", this.onRenamed);
    c.on("unlinked-window-renamed", this.onRenamed);
    c.on("window-close", this.onClosed);
    c.on("unlinked-window-close", this.onClosed);
    c.on("session-changed", this.onSessionChanged);
    c.on("subscription-changed", this.onSubscription);

    if (c.connectionState.status === "ready") this.bootstrap();
    this.publish();
  }

  get state(): WindowTerminalState {
    return this.current;
  }

  /** Calls `cb` with the current state now, then on every change. */
  onState(cb: Listener<WindowTerminalState>): () => void {
    this.stateListeners.add(cb);
    cb(this.current);
    return () => this.stateListeners.delete(cb);
  }

  onError(cb: Listener<WindowTerminalError>): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  /**
   * Pin this browser's keys to `pane`. Never moves tmux's active pane.
   * Throws `RangeError` for a pane the window does not hold.
   */
  focus(pane: PaneId): void {
    if (this.facts?.panes.some((p) => p.id === pane) !== true) {
      throw new RangeError(`${pane} is not a pane of ${this.windowId}`);
    }
    this.policy = { kind: "pinned", pane };
    this.publish();
  }

  dispose(): void {
    if (this.ended) return;
    this.end();
    this.stateListeners.clear();
    this.errorListeners.clear();
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  private rebootstrap(): void {
    if (this.sync.kind === "gone") return;
    if (this.connection.connectionState.status !== "ready") return;
    this.bootstrap();
  }

  private bootstrap(): void {
    const epoch = ++this.epoch;
    this.queue = [];
    void this.runBootstrap(epoch).catch((err: unknown) => {
      if (epoch !== this.epoch) return;
      this.queue = null;
      // A lost connection re-bootstraps when it is ready again.
      if (!isConnectionGone(err))
        this.report({ seam: "bootstrap", cause: err });
    });
  }

  private async runBootstrap(epoch: number): Promise<void> {
    const c = this.connection;
    const [attached, all] = await Promise.all([
      c.execute(ATTACHED_WINDOWS_COMMAND),
      c.execute(ALL_WINDOWS_COMMAND),
    ]);
    if (epoch !== this.epoch) return;
    const membership = parseMembership(
      this.windowId,
      attached.output,
      all.output,
    );
    if (membership !== "attached") {
      this.sync = { kind: "gone", reason: membership };
      this.publish();
      return;
    }
    this.subscribe();
    const [snapshot, panes] = await Promise.all([
      c.execute(snapshotCommand(this.windowId)),
      listPanes(c),
    ]);
    if (epoch !== this.epoch) return;
    const first = factsFromSnapshot(
      parseSnapshot(this.windowId, snapshot.output, panes),
    );
    if (first.kind === "malformed") {
      throw new TmuxReplyFormatError(
        snapshotCommand(this.windowId),
        snapshot.output,
      );
    }
    let facts = first.facts;
    for (const ev of this.queue ?? []) facts = this.reduce(facts, ev);
    this.queue = null;
    this.facts = facts;
    this.sync = { kind: "synced" };
    this.reconcilePanes();
    this.publish();
  }

  /**
   * The window's flags and its panes' titles and commands. Re-issued by every
   * bootstrap: a reconnect can be a new control client, and the same name
   * replaces.
   */
  private subscribe(): void {
    const onFail = (err: unknown): void => {
      if (!isConnectionGone(err))
        this.report({ seam: "subscribe", cause: err });
    };
    this.subscribed = true;
    void this.connection
      .subscribeRaw(this.flagsName, this.windowId, FLAGS_FORMAT)
      .catch(onFail);
    void this.connection
      .subscribeRaw(this.metaName, "%*", PANE_META_FORMAT)
      .catch(onFail);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private apply(ev: WindowEvent): void {
    if (this.sync.kind === "gone") return;
    this.queue?.push(ev);
    if (this.facts === null || this.sync.kind !== "synced") return;
    this.facts = this.reduce(this.facts, ev);
    this.reconcilePanes();
    this.publish();
  }

  private reduce(facts: WindowFacts, ev: WindowEvent): WindowFacts {
    const next = reduceWindow(facts, ev);
    if (next.kind === "facts") return next.facts;
    this.report({ seam: "layout", cause: new Error(next.reason) });
    return facts;
  }

  private malformedValue(value: string): void {
    this.report({
      seam: "subscribe",
      cause: new TmuxReplyFormatError("refresh-client -B", [value]),
    });
  }

  // -------------------------------------------------------------------------
  // Panes
  // -------------------------------------------------------------------------

  /**
   * One stream and one surface per pane in the layout. A zoom hides panes; it
   * never removes them, so zooming detaches nothing.
   */
  private reconcilePanes(): void {
    const facts = this.facts;
    if (facts === null) return;
    const { added, removed } = paneDiff(
      [...this.panes.keys()],
      facts.panes.map((p) => p.id),
    );
    for (const id of removed) this.disposePane(id);
    for (const id of added) this.createPane(id);
  }

  private createPane(id: PaneId): void {
    const stream = new PaneStream({
      client: this.connection,
      paneId: paneNumber(id),
      historyLines: this.history,
    });
    const surface = this.surfaces.create(id, (data) => {
      void stream.sendKeys(data).catch((err: unknown) => {
        if (!isConnectionGone(err)) {
          this.report({ seam: "send-keys", paneId: id, cause: err });
        }
      });
    });
    stream.on("error", (e) =>
      this.report({ seam: e.phase, paneId: id, cause: e.cause }),
    );
    // Attached before the state listener: the change this call makes is
    // published once, by whoever is reconciling.
    stream.attach(surface.sink);
    const offState = stream.on("state-changed", () => this.publish());
    this.panes.set(id, { stream, surface, offState });
  }

  private disposePane(id: PaneId): void {
    const slot = this.panes.get(id);
    if (slot === undefined) return;
    this.panes.delete(id);
    slot.offState();
    slot.stream.dispose();
    slot.surface.dispose();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private view(): WindowView | null {
    if (this.facts === null) return null;
    const resyncing = new Set<PaneId>();
    for (const [id, slot] of this.panes) {
      if (slot.stream.state === "seeding") resyncing.add(id);
    }
    return deriveView(this.facts, this.policy, resyncing);
  }

  private publish(): void {
    if (this.ended) return;
    this.current = phaseFor(
      this.connection.connectionState,
      this.sync,
      this.view(),
      this.current,
      this.now(),
    );
    const final = this.current.phase === "gone";
    for (const cb of this.stateListeners) cb(this.current);
    if (final) this.end();
  }

  private report(e: Omit<WindowTerminalError, "windowId">): void {
    if (this.ended) return;
    const error: WindowTerminalError = { windowId: this.windowId, ...e };
    for (const cb of this.errorListeners) cb(error);
  }

  /** The one teardown: `gone` and `dispose` both end here. */
  private end(): void {
    this.ended = true;
    this.epoch++;
    this.queue = null;
    const c = this.connection;
    c.off("connection-state", this.onConnectionState);
    c.off("layout-change", this.onLayout);
    c.off("window-pane-changed", this.onActive);
    c.off("window-renamed", this.onRenamed);
    c.off("unlinked-window-renamed", this.onRenamed);
    c.off("window-close", this.onClosed);
    c.off("unlinked-window-close", this.onClosed);
    c.off("session-changed", this.onSessionChanged);
    c.off("subscription-changed", this.onSubscription);
    for (const id of [...this.panes.keys()]) this.disposePane(id);
    if (this.subscribed && c.connectionState.status !== "closed") {
      void c.unsubscribe(this.flagsName).catch(rethrowUnlessUnsubscribed);
      void c.unsubscribe(this.metaName).catch(rethrowUnlessUnsubscribed);
    }
  }
}
