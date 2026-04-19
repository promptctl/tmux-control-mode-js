// examples/web-multiplexer/web/inspector-store.ts
//
// InspectorStore — reactive ring buffer of wire activity for the
// Protocol Inspector. This is the "Wireshark for tmux control mode":
// every byte-equivalent that crosses the bridge WebSocket in either
// direction becomes an entry here, with timing and request/response
// correlation.
//
// [LAW:one-source-of-truth] The store's `entries` array is the single
// canonical timeline. All derived views (filters, search, latency
// annotations) are computed from it. Nothing else in the app talks to
// `BridgeClient.onWire` — if it did, entries could diverge.
//
// [LAW:dataflow-not-control-flow] The append path is unconditional:
// every wire entry goes into the ring, then the same filter pipeline
// runs on every render. Pause is expressed as a boolean consumed by
// the append path — not as a branch that disables a subscriber.

import { makeAutoObservable } from "mobx";
import type { BridgeClient, WireEntry } from "./ws-client.ts";
import type { SerializedTmuxMessage } from "../shared/protocol.ts";

/**
 * One row in the inspector timeline. Wraps a raw WireEntry with a
 * monotonic id (stable React key + selection target) and, for outbound
 * requests, a resolved latency once the response lands.
 */
export interface InspectorEntry {
  readonly id: number;
  readonly ts: number;
  readonly wire: WireEntry;
  /** For outbound requests: the monotonic id of the matching response entry, once received. */
  responseEntryId: number | null;
  /** For outbound requests: round-trip latency in ms, filled in when the response arrives. */
  latencyMs: number | null;
}

const MAX_ENTRIES = 1000;

export class InspectorStore {
  entries: InspectorEntry[] = [];
  paused: boolean = false;
  search: string = "";
  hiddenDirections: Record<WireEntry["dir"], boolean> = {
    out: false,
    "in-event": false,
    "in-response": false,
    "in-error": false,
  };
  hiddenEventTypes: Record<string, true> = {};
  selectedId: number | null = null;

  private nextId = 1;
  /**
   * [LAW:one-source-of-truth] Maps outbound request wire-id → the
   * monotonic InspectorEntry id of that request. When a response
   * arrives we patch the request entry with the latency and the
   * response's monotonic id, enabling two-way navigation in the UI.
   */
  private readonly pendingByWireId = new Map<string, number>();
  private readonly disposeWire: () => void;

  constructor(client: BridgeClient) {
    makeAutoObservable(this);
    this.disposeWire = client.onWire((e) => this.ingest(e));
  }

  dispose(): void {
    this.disposeWire();
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  private ingest(wire: WireEntry): void {
    if (this.paused) return;

    const entry: InspectorEntry = {
      id: this.nextId++,
      ts: wire.ts,
      wire,
      responseEntryId: null,
      latencyMs: null,
    };

    // Record outbound requests so the matching response can patch in
    // the round-trip latency.
    if (wire.dir === "out" && wire.msg.kind !== "detach") {
      this.pendingByWireId.set(wire.msg.id, entry.id);
    }

    // Correlate responses to their originating request entry.
    if (wire.dir === "in-response") {
      const reqEntryId = this.pendingByWireId.get(wire.id);
      if (reqEntryId !== undefined) {
        this.pendingByWireId.delete(wire.id);
        const reqIdx = this.entries.findIndex((e) => e.id === reqEntryId);
        if (reqIdx !== -1) {
          // Immutable-ish patch: replace the entry so MobX observers
          // that hold an entry reference from a previous render still
          // see a stable object, while the array reference changes.
          const patched: InspectorEntry = {
            ...this.entries[reqIdx],
            responseEntryId: entry.id,
            latencyMs: wire.latencyMs,
          };
          this.entries = [
            ...this.entries.slice(0, reqIdx),
            patched,
            ...this.entries.slice(reqIdx + 1),
          ];
        }
      }
    }

    this.entries.push(entry);

    // Ring-buffer cap. If we drop an entry that still has a pending
    // request mapping, evict that mapping too — the UI will still show
    // the response in the list, it just won't be able to back-link.
    if (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.shift();
      if (dropped !== undefined && dropped.wire.dir === "out") {
        const msg = dropped.wire.msg;
        if (msg.kind !== "detach") this.pendingByWireId.delete(msg.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  togglePause(): void {
    this.paused = !this.paused;
  }

  clear(): void {
    this.entries = [];
    this.pendingByWireId.clear();
    this.selectedId = null;
  }

  setSearch(s: string): void {
    this.search = s;
  }

  toggleDirection(dir: WireEntry["dir"]): void {
    this.hiddenDirections[dir] = !this.hiddenDirections[dir];
  }

  toggleEventType(type: string): void {
    if (this.hiddenEventTypes[type] === true) {
      delete this.hiddenEventTypes[type];
    } else {
      this.hiddenEventTypes[type] = true;
    }
  }

  clearFilters(): void {
    this.hiddenDirections = {
      out: false,
      "in-event": false,
      "in-response": false,
      "in-error": false,
    };
    this.hiddenEventTypes = {};
    this.search = "";
  }

  select(id: number | null): void {
    this.selectedId = id;
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  /** All unique event-type strings seen among in-event entries. Sorted. */
  get knownEventTypes(): string[] {
    const s = new Set<string>();
    for (const e of this.entries) {
      if (e.wire.dir === "in-event") s.add(e.wire.event.type);
    }
    return [...s].sort();
  }

  /**
   * Entries passing the current filter set. The filter pipeline is
   * deliberately flat and unconditional — direction filter → event-type
   * filter → search substring — so adding a new dimension means adding
   * one more clause, not restructuring control flow.
   */
  get visibleEntries(): InspectorEntry[] {
    const { hiddenDirections, hiddenEventTypes } = this;
    const needle = this.search.trim().toLowerCase();
    return this.entries.filter((e) => {
      if (hiddenDirections[e.wire.dir]) return false;
      if (e.wire.dir === "in-event" && hiddenEventTypes[e.wire.event.type]) {
        return false;
      }
      if (needle.length === 0) return true;
      return summarizeForSearch(e.wire).toLowerCase().includes(needle);
    });
  }

  get selectedEntry(): InspectorEntry | null {
    if (this.selectedId === null) return null;
    return this.entries.find((e) => e.id === this.selectedId) ?? null;
  }

  /** Count of entries bucketed by direction, unfiltered. */
  get counts(): Record<WireEntry["dir"], number> {
    const c: Record<WireEntry["dir"], number> = {
      out: 0,
      "in-event": 0,
      "in-response": 0,
      "in-error": 0,
    };
    for (const e of this.entries) c[e.wire.dir]++;
    return c;
  }
}

// ---------------------------------------------------------------------------
// Search surface
// ---------------------------------------------------------------------------

/**
 * Flatten a wire entry to a single searchable string. Includes the
 * type/direction, pane/window/session ids where relevant, and for
 * outbound `execute` the literal command text. The inspector's search
 * box matches against this string so users can type `resize-pane`,
 * `%output`, `r12`, or a pane id like `%5` and get hits.
 */
function summarizeForSearch(w: WireEntry): string {
  if (w.dir === "out") {
    if (w.msg.kind === "execute") return `out execute ${w.msg.id} ${w.msg.command}`;
    if (w.msg.kind === "sendKeys")
      return `out sendKeys ${w.msg.id} ${w.msg.target} ${w.msg.keys}`;
    return `out detach ${w.msg.id}`;
  }
  if (w.dir === "in-event") return `in event %${w.event.type} ${eventSearchTail(w.event)}`;
  if (w.dir === "in-response") {
    return `in response ${w.id} ${w.response.success ? "ok" : "err"} ${w.response.output.join(" ")}`;
  }
  return `in error ${w.id ?? ""} ${w.message}`;
}

function eventSearchTail(ev: SerializedTmuxMessage): string {
  // Keep this cheap — it runs per filter pass. Include only the fields
  // users will realistically search for (ids + names).
  const bag: string[] = [];
  if ("paneId" in ev) bag.push(`%${ev.paneId}`);
  if ("windowId" in ev) bag.push(`@${ev.windowId}`);
  if ("sessionId" in ev) bag.push(`$${ev.sessionId}`);
  if ("name" in ev && typeof ev.name === "string") bag.push(ev.name);
  if ("clientName" in ev) bag.push(ev.clientName);
  if ("reason" in ev && typeof ev.reason === "string") bag.push(ev.reason);
  if ("message" in ev && typeof ev.message === "string") bag.push(ev.message);
  return bag.join(" ");
}
