// src/window-terminal/engine/pane-sizes.ts
//
// `PaneSizes` — one per connection: tmux's report of every pane's size on the
// server, through ONE format subscription, handed to every `PaneStream` on
// that connection so each reads its own pane from it.
//
// [LAW:one-source-of-truth] The sizes of the server's panes are one fact per
//   connection, so they are one subscription per connection. tmux expands
//   every subscription once a second on its single thread, and finding one
//   pane server-wide means walking all of them: a subscription per stream
//   costs streams × panes (30 streams over 400 panes held tmux ~35ms of every
//   second), one shared one costs panes.
// [LAW:single-enforcer] One `subscription-changed` listener and one parse per
//   report, whatever the number of streams.

import type {
  SubscriptionSurface,
  TmuxConnection,
  TmuxEventMap,
} from "../../browser.js";
import type { Grid } from "./terminal-sink.js";
import { parseGrid } from "./seed-builder.js";
import { uniqueToken } from "./token.js";
import { rethrowUnlessUnsubscribed } from "./teardown.js";

type SizesConnection = TmuxConnection & SubscriptionSurface;

/** Every pane tmux reported, by pane number. */
export type PaneSizeMap = ReadonlyMap<number, Grid>;

/** A registrant handed each report. `PaneStream` implements this. */
export interface PaneSizesTarget {
  sizesReported(sizes: PaneSizeMap): void;
}

// Every pane on the server, by session and window: `%N=w;h,`. A pane whose
// window is linked into several sessions appears once per link. Scoped to the
// session (empty `what`) because a pane-scoped subscription is walked only
// over the control client's own session. `#,` because a bare comma in a `P`
// loop starts its active-pane format.
const PANE_SIZES_FORMAT =
  "#{S:#{W:#{P:#{pane_id}=#{pane_width};#{pane_height}#,}}}";

const ENTRY = /^%(0|[1-9]\d*)=(\d+);(\d+)$/;

// [LAW:parse-dont-validate] The shape `PANE_SIZES_FORMAT` produces; anything
// else is no report. A repeated pane (linked window) carries tmux's one size
// for it, so the repeat overwrites with the same value.
export function parsePaneSizes(value: string): PaneSizeMap | null {
  const entries = value.split(",");
  if (entries.pop() !== "") return null;
  const sizes = new Map<number, Grid>();
  for (const entry of entries) {
    const m = ENTRY.exec(entry);
    const grid = m === null ? null : parseGrid(m[2], m[3]);
    if (m === null || grid === null) return null;
    sizes.set(Number(m[1]), grid);
  }
  return sizes;
}

export class PaneSizes {
  private readonly client: SizesConnection;
  // tmux keys subscriptions by name per control client, and several pages can
  // share one control client through a bridge: one name per instance.
  private readonly name = `wt-${uniqueToken()}-pane-sizes`;
  private readonly targets = new Set<PaneSizesTarget>();

  private readonly onSubscriptionChanged = (
    ev: TmuxEventMap["subscription-changed"],
  ): void => {
    if (ev.name !== this.name) return;
    const sizes = parsePaneSizes(ev.value);
    if (sizes === null) return;
    for (const t of this.targets) t.sizesReported(sizes);
  };

  constructor(client: SizesConnection) {
    this.client = client;
  }

  // The listener and the subscription live while any target does, so a
  // connection with no streams on it holds neither.
  register(target: PaneSizesTarget): void {
    if (this.targets.size === 0) {
      this.client.on("subscription-changed", this.onSubscriptionChanged);
    }
    this.targets.add(target);
  }

  unregister(target: PaneSizesTarget): void {
    this.targets.delete(target);
    if (this.targets.size > 0) return;
    this.client.off("subscription-changed", this.onSubscriptionChanged);
    // Any failure but an already-absent subscription has nobody left to
    // report to here, so it surfaces as an unhandled rejection.
    void this.client.unsubscribe(this.name).catch(rethrowUnlessUnsubscribed);
  }

  /**
   * (Re-)issue the shared subscription. Re-issuing a name makes tmux send the
   * whole value again at its next check, so a target joining a subscription
   * that is already reporting gets its pane's size within a check; and each
   * caller holds its own outcome.
   */
  subscribe(): Promise<unknown> {
    return this.client.subscribeRaw(this.name, "", PANE_SIZES_FORMAT);
  }
}

// [LAW:one-source-of-truth] Module-scope WeakMap keyed by connection, as
// `getScheduler`: every stream on a connection shares one `PaneSizes`.
const PANE_SIZES = new WeakMap<SizesConnection, PaneSizes>();

export function getPaneSizes(client: SizesConnection): PaneSizes {
  const existing = PANE_SIZES.get(client);
  if (existing !== undefined) return existing;
  const created = new PaneSizes(client);
  PANE_SIZES.set(client, created);
  return created;
}
