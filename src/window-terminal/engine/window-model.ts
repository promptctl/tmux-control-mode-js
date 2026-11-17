// src/window-terminal/engine/window-model.ts
//
// The window model: what the terminal knows about one tmux window (its facts),
// how a tmux event changes them, and the public picture derived from them.
//
// [LAW:effects-at-boundaries] Pure. The engine performs every effect; this
//   module turns events into facts and facts into views.
// [LAW:one-source-of-truth] One source per fact. Rects, order, size, zoom and
//   pane membership come from a layout (the bootstrap's and every
//   `%layout-change` go through the one `applyLayout` arm); the active pane
//   from the bootstrap, then `%window-pane-changed`; the name from the
//   bootstrap, then the renamed notifications; flags and per-pane title and
//   command from the bootstrap, then their subscriptions. `WindowView` is
//   derived from the facts on every read — never stored beside them.

import type {
  ConnectionState,
  PaneGeometry,
  WindowLayoutFields,
} from "../../browser.js";
import { paneIdOf, type PaneId, type WindowId } from "../ids.js";

// ---------------------------------------------------------------------------
// The public picture
// ---------------------------------------------------------------------------

/** A pane's cell in tmux's layout, in cells from the window's top left. */
export interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly cols: number;
  readonly rows: number;
}

export interface PaneView {
  readonly id: PaneId;
  readonly title: string;
  readonly command: string;
  readonly rect: PaneRect;
  /** The pane's picture is being (re)captured: on arrival and after a flood. */
  readonly resyncing: boolean;
}

export interface WindowFlags {
  readonly bell: boolean;
  readonly activity: boolean;
  readonly silence: boolean;
}

export interface WindowView {
  readonly id: WindowId;
  readonly name: string;
  readonly size: { readonly cols: number; readonly rows: number };
  readonly flags: WindowFlags;
  /**
   * tmux's active pane: where a tmux client's keys go. A new pane is named
   * active before the layout holding it arrives, so for that moment it is in
   * no entry of `panes`.
   */
  readonly active: PaneId;
  /** This browser's focused pane: where this terminal's keys go. */
  readonly focus: PaneId;
  readonly zoomed: PaneId | null;
  /** Every pane in tmux's layout order; when zoomed, the others are hidden, not gone. */
  readonly panes: readonly PaneView[];
}

export type WindowTerminalState =
  | { readonly phase: "connecting" }
  | { readonly phase: "live"; readonly window: WindowView }
  | {
      readonly phase: "stale";
      readonly window: WindowView;
      readonly since: number;
      readonly reason: string;
    }
  | {
      readonly phase: "gone";
      readonly reason:
        | "window-closed"
        | "connection-closed"
        | "window-unreachable"
        | "bootstrap-failed";
      readonly detail?: string;
    };

/**
 * A tmux command the terminal issued failed while tmux was reachable, or a
 * frame or a pane failed to draw (`render`: cells that measure as nothing, or
 * a host addon that threw as the pane opened, which leaves it empty). A lost
 * connection is never one of these: it is the `stale` phase.
 */
export interface WindowTerminalError {
  readonly seam:
    | "seed"
    | "subscribe"
    | "declare-size"
    | "send-keys"
    | "bootstrap"
    | "layout"
    | "render";
  readonly windowId: WindowId;
  readonly paneId?: PaneId;
  readonly cause: unknown;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface PaneMeta {
  readonly title: string;
  readonly command: string;
}

interface LayoutPane {
  readonly id: PaneId;
  readonly rect: PaneRect;
}

export interface WindowFacts {
  readonly id: WindowId;
  readonly name: string;
  readonly active: PaneId;
  readonly flags: WindowFlags;
  /** Layout order; a zoomed pane's rect is the whole window. */
  readonly panes: readonly LayoutPane[];
  readonly size: { readonly cols: number; readonly rows: number };
  readonly zoomed: PaneId | null;
  /** Title and command per pane. May hold a pane the layout has not reached yet. */
  readonly meta: ReadonlyMap<PaneId, PaneMeta>;
}

export type WindowEvent =
  | { readonly kind: "layout"; readonly layout: WindowLayoutFields }
  | { readonly kind: "active"; readonly pane: PaneId }
  | { readonly kind: "renamed"; readonly name: string }
  | { readonly kind: "flags"; readonly flags: WindowFlags }
  | {
      readonly kind: "pane-meta";
      readonly pane: PaneId;
      readonly meta: PaneMeta;
    };

/** The result of applying an event: new facts, or why the event was refused. */
export type Reduced =
  | { readonly kind: "facts"; readonly facts: WindowFacts }
  | { readonly kind: "malformed"; readonly reason: string };

const rectOf = (g: PaneGeometry): PaneRect => ({
  x: g.x,
  y: g.y,
  cols: g.width,
  rows: g.height,
});

/**
 * The layout arm. `#{window_layout}` holds every tiled pane at its pre-zoom
 * cell; when the window is zoomed (`Z` in its flags) `#{window_visible_layout}`
 * holds only the zoomed pane, at the whole window's size.
 */
function applyLayout(
  facts: Omit<WindowFacts, "panes" | "size" | "zoomed">,
  layout: WindowLayoutFields,
): Reduced {
  if (layout.layout.kind === "malformed") {
    return { kind: "malformed", reason: layout.layout.reason };
  }
  const tiled = layout.layout.panes;
  const zoomedGeometry =
    layout.windowFlags.includes("Z") && layout.visibleLayout.kind === "parsed"
      ? (layout.visibleLayout.panes[0] ?? null)
      : null;
  if (layout.windowFlags.includes("Z") && zoomedGeometry === null) {
    return {
      kind: "malformed",
      reason: `zoomed window with no visible pane in "${layout.windowVisibleLayout}"`,
    };
  }
  const zoomed =
    zoomedGeometry === null ? null : paneIdOf(zoomedGeometry.paneId);
  const panes = tiled.map((g) => {
    const id = paneIdOf(g.paneId);
    return {
      id,
      rect: rectOf(
        id === zoomed && zoomedGeometry !== null ? zoomedGeometry : g,
      ),
    };
  });
  const size = {
    cols: Math.max(0, ...tiled.map((g) => g.x + g.width)),
    rows: Math.max(0, ...tiled.map((g) => g.y + g.height)),
  };
  const ids = new Set(panes.map((p) => p.id));
  const meta = new Map([...facts.meta].filter(([id]) => ids.has(id)));
  return { kind: "facts", facts: { ...facts, meta, panes, size, zoomed } };
}

export function reduceWindow(facts: WindowFacts, ev: WindowEvent): Reduced {
  switch (ev.kind) {
    case "layout":
      return applyLayout(facts, ev.layout);
    case "active":
      return { kind: "facts", facts: { ...facts, active: ev.pane } };
    case "renamed":
      return { kind: "facts", facts: { ...facts, name: ev.name } };
    case "flags":
      return { kind: "facts", facts: { ...facts, flags: ev.flags } };
    case "pane-meta":
      return {
        kind: "facts",
        facts: { ...facts, meta: new Map(facts.meta).set(ev.pane, ev.meta) },
      };
  }
}

/** What the bootstrap read, before the layout arm turns it into facts. */
export interface WindowSnapshot {
  readonly id: WindowId;
  readonly name: string;
  readonly active: PaneId;
  readonly flags: WindowFlags;
  readonly layout: WindowLayoutFields;
  readonly meta: ReadonlyMap<PaneId, PaneMeta>;
}

export function factsFromSnapshot(s: WindowSnapshot): Reduced {
  return applyLayout(
    { id: s.id, name: s.name, active: s.active, flags: s.flags, meta: s.meta },
    s.layout,
  );
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

/**
 * Where this browser's keys go. Starts following tmux's active pane — the only
 * defensible default before the person has chosen. A click or `focus()` pins,
 * so a `select-pane` from another client never redirects keys mid-typing.
 */
export type FocusPolicy =
  | { readonly kind: "follow-active" }
  | { readonly kind: "pinned"; readonly pane: PaneId };

/**
 * The focused pane, derived. A zoomed window shows one pane, so keys go there
 * (never to a hidden pane); the pin survives the zoom and applies again after
 * it. A pin on a pane that has left the layout reads as tmux's active pane
 * (tmux never reuses a pane id, so that pane cannot return).
 */
function focusOf(facts: WindowFacts, policy: FocusPolicy): PaneId {
  if (facts.zoomed !== null) return facts.zoomed;
  return policy.kind === "pinned" &&
    facts.panes.some((p) => p.id === policy.pane)
    ? policy.pane
    : facts.active;
}

const NO_META: PaneMeta = { title: "", command: "" };

export function deriveView(
  facts: WindowFacts,
  focus: FocusPolicy,
  resyncing: ReadonlySet<PaneId>,
): WindowView {
  return {
    id: facts.id,
    name: facts.name,
    size: facts.size,
    flags: facts.flags,
    active: facts.active,
    focus: focusOf(facts, focus),
    zoomed: facts.zoomed,
    panes: facts.panes.map((p) => ({
      id: p.id,
      ...(facts.meta.get(p.id) ?? NO_META),
      rect: p.rect,
      resyncing: resyncing.has(p.id),
    })),
  };
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/**
 * Whether the facts describe the window as it stands on this connection.
 *
 * - `unsynced` — not bootstrapped since the connection last became ready.
 * - `synced` — bootstrapped, and following the window's notifications.
 * - `gone` — the window closed, was never reachable, or tmux answered the
 *   bootstrap and it failed (a refused command, a reply it cannot read),
 *   which nothing on a live connection would retry; final.
 */
export type Sync =
  | { readonly kind: "unsynced" }
  | { readonly kind: "synced" }
  | {
      readonly kind: "gone";
      readonly reason:
        | "window-closed"
        | "window-unreachable"
        | "bootstrap-failed";
      readonly detail?: string;
    };

// A closed connection is gone, never stale.
function staleReason(
  conn: Exclude<ConnectionState, { readonly status: "closed" }>,
): string {
  switch (conn.status) {
    case "reconnecting":
      return conn.lastError === undefined
        ? `reconnecting (attempt ${conn.attempt})`
        : `reconnecting (attempt ${conn.attempt}): ${conn.lastError.message}`;
    case "connecting":
      return "connecting";
    case "ready":
      return "reconnected; resyncing the window";
  }
}

/**
 * The one phase function. `view` is the last picture (null before the first
 * bootstrap); `prev` carries a stale phase's `since` forward, and `now` stamps
 * a stale phase that starts here.
 */
export function phaseFor(
  conn: ConnectionState,
  sync: Sync,
  view: WindowView | null,
  prev: WindowTerminalState,
  now: number,
): WindowTerminalState {
  if (sync.kind === "gone") {
    return sync.detail === undefined
      ? { phase: "gone", reason: sync.reason }
      : { phase: "gone", reason: sync.reason, detail: sync.detail };
  }
  if (conn.status === "closed") {
    return {
      phase: "gone",
      reason: "connection-closed",
      detail:
        conn.reason === "refused"
          ? `refused: ${conn.error.message}`
          : conn.reason,
    };
  }
  if (view === null) return { phase: "connecting" };
  if (conn.status === "ready" && sync.kind === "synced") {
    return { phase: "live", window: view };
  }
  return {
    phase: "stale",
    window: view,
    since: prev.phase === "stale" ? prev.since : now,
    reason: staleReason(conn),
  };
}
