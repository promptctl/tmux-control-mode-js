// examples/web-multiplexer/server/mirror-registry.ts
// MirrorRegistry — the SOURCE OF TRUTH behind the read-only pane mirror.
//
// One dedicated server-side tmux control client taps a pane's raw output and
// fans it to every browser watching that pane. The browsers are pure
// PROJECTIONS: they receive bytes and a viewer count, and send nothing back
// (the `/mirror` endpoint has no inbound vocabulary). This class is where the
// "one source, N projections" asymmetry lives.
//
// [LAW:one-source-of-truth] A pane is tapped ONCE no matter how many browsers
//   watch it. The hub is keyed by pane id and ref-counted by its viewer set;
//   the first viewer stands the tap up, the last to leave tears it down. Five
//   viewers of %3 share one `pipe-pane`, one seed source, one byte stream.
// [LAW:no-shared-mutable-globals] Single owner (the bridge server constructs
//   exactly one), explicit API (`addViewer` / `close`), documented invariants.
// [LAW:no-ambient-temporal-coupling] Seed ordering has one owner: a joining
//   viewer is sent the `capture-pane` screen and THEN added to the live
//   fan-out. Bytes arriving in the sub-frame capture window are dropped (they
//   are already baked into the captured screen) rather than double-painted —
//   the same loss-over-double-count choice the recording demos (.5/.9) made.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxClient } from "@promptctl/tmux-control-mode-js";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import { tapPaneToFifo } from "./pane-tap.js";
import { spawnReadyControlClient } from "./control-client.js";
import { buildMirrorSeed, type MirrorControlFrame } from "../shared/mirror-frame.js";

/**
 * The viewer-facing surface the `/mirror` endpoint hands the registry. The
 * registry only ever PUSHES to a viewer — there is no method to receive from
 * it. [LAW:types-are-the-program] read-only is the shape, not a flag.
 */
export interface MirrorViewer {
  /** Send a JSON lifecycle frame (size / viewers / gone / error). */
  sendControl(frame: MirrorControlFrame): void;
  /** Send raw pane bytes for the terminal sink (seed first, then live). */
  sendBytes(data: Uint8Array): void;
  /** Server-initiated close of the underlying transport (e.g. pane gone). */
  close(): void;
}

/** One tapped pane and the viewers projecting it. */
interface Hub {
  readonly paneId: number;
  readonly viewers: Set<MirrorViewer>;
  dispose: () => void;
}

/** How often to re-check that every mirrored pane still exists. */
const LIVENESS_INTERVAL_MS = 1500;

export class MirrorRegistry {
  private readonly hubs = new Map<number, Hub>();
  private client: TmuxClient | null = null;
  // Resolves when the dedicated client has reached `ready` (first byte from
  // tmux). Gating the first viewer's tap + seed behind this avoids the
  // control-mode cold-start race; the gate itself is owned by
  // `spawnReadyControlClient`. [LAW:no-ambient-temporal-coupling]
  private ready: Promise<void> | null = null;
  private dir: string | null = null;
  private liveness: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private closed = false;

  /**
   * Attach a viewer to a pane's mirror, seeding it with the pane's current
   * screen, then joining it to the live byte fan-out. Returns a disposer the
   * endpoint calls when the viewer's socket closes.
   *
   * Failures to seed (bad pane id, pane already gone) send an `error` frame and
   * return a no-op disposer — the viewer is never silently joined to a stream
   * that will never produce bytes. [LAW:no-silent-failure]
   */
  async addViewer(paneId: number, viewer: MirrorViewer): Promise<() => void> {
    if (this.closed) {
      viewer.sendControl({ kind: "error", message: "bridge is shutting down" });
      return () => {};
    }
    // Settle the dedicated client before the first tap/seed (cold-start race).
    this.ensureClient();
    await this.ready;
    if (this.closed) {
      viewer.sendControl({ kind: "error", message: "bridge is shutting down" });
      return () => {};
    }
    const hub = this.ensureHub(paneId);

    // Geometry first: a fresh XtermSink buffers every write until its first
    // resize (the `.4` first-paint finding), so the viewer needs cols/rows
    // before the seed bytes mean anything.
    const size = await this.querySize(paneId);
    if (size === null) {
      viewer.sendControl({
        kind: "error",
        message: `pane %${paneId} not found`,
      });
      this.gcHub(hub);
      return () => {};
    }
    viewer.sendControl({ kind: "size", cols: size.cols, rows: size.rows });

    // Seed = the pane's current rendered screen. Sent BEFORE the viewer joins
    // the live fan-out, so live bytes never race ahead of the seed.
    const capture = await this.client!.execute(
      `capture-pane -e -p -t %${paneId}`,
    ).catch((r: CommandResponse) => r);
    if (!capture.success) {
      viewer.sendControl({
        kind: "error",
        message: `capture-pane failed for %${paneId}`,
      });
      this.gcHub(hub);
      return () => {};
    }
    viewer.sendBytes(buildMirrorSeed(capture.output));

    // Join the live stream. From here every tapped byte reaches this viewer.
    hub.viewers.add(viewer);
    this.broadcastViewers(hub);

    return () => this.removeViewer(paneId, viewer);
  }

  /** Tear down every hub, the dedicated client, and the FIFO directory. */
  close(): void {
    this.closed = true;
    this.stopLiveness();
    for (const hub of [...this.hubs.values()]) {
      hub.dispose();
      for (const v of hub.viewers) v.close();
    }
    this.hubs.clear();
    this.client?.close();
    this.client = null;
    if (this.dir !== null) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        // Best effort — streams are closed; a leftover dir is harmless.
      }
      this.dir = null;
    }
  }

  // -------------------------------------------------------------------------

  /** Lazily spawn the one control client + FIFO dir the registry shares. */
  private ensureClient(): TmuxClient {
    if (this.client === null) {
      const { client, ready } = spawnReadyControlClient();
      this.client = client;
      this.ready = ready;
    }
    if (this.dir === null) {
      this.dir = mkdtempSync(join(tmpdir(), "tmux-mirror-"));
    }
    return this.client;
  }

  /** Get the hub for a pane, creating (and tapping) it on first viewer. */
  private ensureHub(paneId: number): Hub {
    const existing = this.hubs.get(paneId);
    if (existing !== undefined) return existing;

    const client = this.ensureClient();
    const hub: Hub = { paneId, viewers: new Set(), dispose: () => {} };
    hub.dispose = tapPaneToFifo(
      (command) => client.execute(command),
      this.dir!,
      paneId,
      (data) => {
        for (const v of hub.viewers) v.sendBytes(data);
      },
      // A tap that fails to stand up / errors mid-stream means the pane is gone.
      { onReadError: () => this.endHub(hub) },
    );
    this.hubs.set(paneId, hub);
    this.startLiveness();
    return hub;
  }

  private removeViewer(paneId: number, viewer: MirrorViewer): void {
    const hub = this.hubs.get(paneId);
    if (hub === undefined) return;
    hub.viewers.delete(viewer);
    this.broadcastViewers(hub);
    this.gcHub(hub);
  }

  /** Drop a hub once it has no viewers; stop polling once no hubs remain. */
  private gcHub(hub: Hub): void {
    if (hub.viewers.size > 0) return;
    hub.dispose();
    this.hubs.delete(hub.paneId);
    if (this.hubs.size === 0) this.stopLiveness();
  }

  /** Pane vanished: tell its viewers, close them, and drop the hub. */
  private endHub(hub: Hub): void {
    if (this.hubs.get(hub.paneId) !== hub) return;
    this.hubs.delete(hub.paneId);
    hub.dispose();
    for (const v of hub.viewers) {
      v.sendControl({ kind: "gone" });
      v.close();
    }
    hub.viewers.clear();
    if (this.hubs.size === 0) this.stopLiveness();
  }

  private broadcastViewers(hub: Hub): void {
    const count = hub.viewers.size;
    for (const v of hub.viewers) v.sendControl({ kind: "viewers", count });
  }

  private async querySize(
    paneId: number,
  ): Promise<{ cols: number; rows: number } | null> {
    const r = await this.client!.execute(
      `display-message -p -t %${paneId} -F '#{pane_width} #{pane_height}'`,
    ).catch((resp: CommandResponse) => resp);
    if (!r.success || r.output.length === 0) return null;
    const m = /^(\d+)\s+(\d+)$/.exec(r.output[0].trim());
    if (m === null) return null;
    return { cols: Number(m[1]), rows: Number(m[2]) };
  }

  // Liveness: one poll for the whole registry. `list-panes -a` is the single
  // source of "which panes exist"; any hub whose pane is no longer listed has
  // closed under its viewers. [LAW:one-source-of-truth]
  private startLiveness(): void {
    if (this.liveness !== null) return;
    this.liveness = setInterval(() => void this.checkLiveness(), LIVENESS_INTERVAL_MS);
  }

  private stopLiveness(): void {
    if (this.liveness === null) return;
    clearInterval(this.liveness);
    this.liveness = null;
  }

  private async checkLiveness(): Promise<void> {
    if (this.checking || this.client === null || this.hubs.size === 0) return;
    this.checking = true;
    try {
      const r = await this.client
        .execute("list-panes -a -F '#{pane_id}'")
        .catch((resp: CommandResponse) => resp);
      // [LAW:no-silent-failure] A failed enumeration is left alone, never read
      // as "every pane vanished" (which would gone-out every live mirror).
      if (!r.success) return;
      const present = new Set(
        r.output.flatMap((line) => {
          const m = /^%(\d+)/.exec(line.trim());
          return m !== null ? [Number(m[1])] : [];
        }),
      );
      for (const hub of [...this.hubs.values()]) {
        if (!present.has(hub.paneId)) this.endHub(hub);
      }
    } finally {
      this.checking = false;
    }
  }
}
