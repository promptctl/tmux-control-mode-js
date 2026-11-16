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
import {
  isConnectionGone,
  TransportClosedError,
  type TmuxClient,
} from "@promptctl/tmux-control-mode-js";
import { asCommandResponse } from "../shared/command-response.js";
import { tapPaneToFifo } from "./pane-tap.js";
import { reportDetachedFailure } from "./detached-failure.js";
import {
  DedicatedControlClient,
  spawnDemoClient,
  type SpawnControlClient,
} from "./control-client.js";
import {
  buildMirrorSeed,
  type MirrorControlFrame,
} from "../shared/mirror-frame.js";

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
  readonly dispose: () => void;
}

/** How often to re-check that every mirrored pane still exists. */
const LIVENESS_INTERVAL_MS = 1500;

/** Disposer for a viewer that was refused before joining: nothing to undo. */
function notJoined(): void {
  // no-op: the viewer never joined a hub, so there is nothing to remove.
}

export class MirrorRegistry {
  private readonly hubs = new Map<number, Hub>();
  // Every tap, seed and liveness poll goes to a client this has settled, so
  // none races the control-mode cold start. [LAW:no-ambient-temporal-coupling]
  private readonly connection: DedicatedControlClient;
  private dir: string | null = null;
  private liveness: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private closed = false;

  constructor(spawn: SpawnControlClient = spawnDemoClient) {
    // Every tap died with the connection: end each hub, so its viewers learn
    // the stream is over and the next viewer re-taps over a fresh client.
    this.connection = new DedicatedControlClient(
      "[mirror]",
      () => {
        for (const hub of [...this.hubs.values()]) {
          this.endHub(hub, { kind: "error", message: "tmux connection lost" });
        }
      },
      spawn,
    );
  }

  /**
   * Attach a viewer to a pane's mirror, seeding it with the pane's current
   * screen, then joining it to the live byte fan-out. Returns a disposer the
   * endpoint calls when the viewer's socket closes.
   *
   * A viewer that cannot be seeded (bad pane id, pane already gone, tmux
   * unreachable, bridge shutting down) is refused: sent an `error` frame and
   * closed, with a no-op disposer — never silently joined to a stream that
   * will never produce bytes. [LAW:no-silent-failure]
   *
   * Never rejects: the endpoint fires and forgets, so a failure anywhere in
   * the join refuses the viewer here.
   */
  addViewer(paneId: number, viewer: MirrorViewer): Promise<() => void> {
    return this.seedAndJoin(paneId, viewer).catch((err: unknown) => {
      // The failure may come after the viewer joined; take it back out.
      this.removeViewer(paneId, viewer);
      if (this.closed) {
        refuse(viewer, "bridge is shutting down");
      } else {
        reportDetachedFailure(`[mirror] join of %${paneId}`, err);
        refuse(
          viewer,
          isConnectionGone(err)
            ? "tmux connection lost"
            : `mirror of %${paneId} failed`,
        );
      }
      return notJoined;
    });
  }

  private async seedAndJoin(
    paneId: number,
    viewer: MirrorViewer,
  ): Promise<() => void> {
    const client = await this.connection.ready();
    let hub = this.ensureHub(paneId, client);

    // Geometry first: a fresh XtermSink buffers every write until its first
    // resize (the `.4` first-paint finding), so the viewer needs cols/rows
    // before the seed bytes mean anything.
    const size = await this.querySize(client, paneId);
    if (size === null) {
      refuse(viewer, `pane %${paneId} not found`);
      this.gcHub(hub);
      return notJoined;
    }
    viewer.sendControl({ kind: "size", cols: size.cols, rows: size.rows });

    // Seed = the pane's current rendered screen. Sent BEFORE the viewer joins
    // the live fan-out, so live bytes never race ahead of the seed.
    const capture = await client
      .execute(`capture-pane -e -p -t %${paneId}`)
      .catch(asCommandResponse);
    if (!capture.success) {
      refuse(viewer, `capture-pane failed for %${paneId}`);
      this.gcHub(hub);
      return notJoined;
    }
    viewer.sendBytes(buildMirrorSeed(capture.output));

    // While this viewer awaited, the hub may have been dropped: another
    // joiner's failed seed GC'd it, or its tap died. Joining the dropped hub
    // would leave this viewer on a stream that never produces bytes and that
    // liveness no longer watches, so join the pane's current hub instead.
    if (this.hubs.get(paneId) !== hub) hub = this.ensureHub(paneId, client);

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
    this.connection.close();
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

  /**
   * Get the hub for a pane, creating (and tapping) it over `client` on first
   * viewer. [LAW:single-enforcer] The one place a hub comes into being, so the
   * one place a closed registry, or a client whose connection has ended under
   * a joiner still seeding, is refused a new one.
   */
  private ensureHub(paneId: number, client: TmuxClient): Hub {
    if (this.closed) throw new Error("mirror registry is closed");
    const existing = this.hubs.get(paneId);
    if (existing !== undefined) return existing;
    if (!this.connection.isLive(client))
      throw new TransportClosedError(undefined);

    this.dir ??= mkdtempSync(join(tmpdir(), "tmux-mirror-"));
    const dir = this.dir;
    const viewers = new Set<MirrorViewer>();
    const hub: Hub = {
      paneId,
      viewers,
      dispose: tapPaneToFifo(
        (command) => client.execute(command),
        dir,
        paneId,
        (data) => {
          for (const v of viewers) v.sendBytes(data);
        },
        // The tap logs why it died; the viewers learn only that it did. The
        // callback names the hub by its viewer set, so it never refers to the
        // `hub` binding still being initialised here.
        {
          onReadError: () => {
            const current = this.hubs.get(paneId);
            if (current?.viewers !== viewers) return;
            this.endHub(current, {
              kind: "error",
              message: `could not tap pane %${paneId}`,
            });
          },
        },
      ),
    };
    this.hubs.set(paneId, hub);
    this.startLiveness();
    return hub;
  }

  private removeViewer(paneId: number, viewer: MirrorViewer): void {
    const hub = this.hubs.get(paneId);
    if (hub === undefined) return;
    if (hub.viewers.delete(viewer)) this.broadcastViewers(hub);
    this.gcHub(hub);
  }

  /** Drop a hub once it has no viewers; stop polling once no hubs remain. */
  private gcHub(hub: Hub): void {
    if (hub.viewers.size > 0) return;
    hub.dispose();
    if (this.hubs.get(hub.paneId) !== hub) return;
    this.hubs.delete(hub.paneId);
    if (this.hubs.size === 0) this.stopLiveness();
  }

  /** The hub's stream ended: tell its viewers why, close them, drop the hub. */
  private endHub(hub: Hub, frame: MirrorControlFrame): void {
    if (this.hubs.get(hub.paneId) !== hub) return;
    this.hubs.delete(hub.paneId);
    hub.dispose();
    for (const v of hub.viewers) {
      v.sendControl(frame);
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
    client: TmuxClient,
    paneId: number,
  ): Promise<{ cols: number; rows: number } | null> {
    const r = await client
      .execute(
        `display-message -p -t %${paneId} -F '#{pane_width} #{pane_height}'`,
      )
      .catch(asCommandResponse);
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
    this.liveness = setInterval(
      () => void this.checkLiveness(),
      LIVENESS_INTERVAL_MS,
    );
  }

  private stopLiveness(): void {
    if (this.liveness === null) return;
    clearInterval(this.liveness);
    this.liveness = null;
  }

  private async checkLiveness(): Promise<void> {
    if (this.checking || this.hubs.size === 0) return;
    this.checking = true;
    try {
      const client = await this.connection.ready();
      const r = await client
        .execute("list-panes -a -F '#{pane_id}'")
        .catch(asCommandResponse);
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
        if (!present.has(hub.paneId)) this.endHub(hub, { kind: "gone" });
      }
    } catch (err) {
      // The poll is fired from a timer, so its failure ends here.
      reportDetachedFailure("[mirror] liveness check", err);
    } finally {
      this.checking = false;
    }
  }
}

/** Tell a viewer why it was not joined, then close it: it will get nothing more. */
function refuse(viewer: MirrorViewer, message: string): void {
  viewer.sendControl({ kind: "error", message });
  viewer.close();
}
