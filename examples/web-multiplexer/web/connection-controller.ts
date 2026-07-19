// examples/web-multiplexer/web/connection-controller.ts
//
// ConnectionController — owns the connection state machine and the one-time
// work that must happen when the bridge reaches "ready": installing the three
// tmux format subscriptions that drive the entire model, seeding it with an
// initial list-* snapshot, and bootstrapping the attached-session pointer.
// Steady-state event routing is RefreshPolicy's job; this is only the
// lifecycle + bootstrap. [LAW:decomposition]

import { makeAutoObservable, runInAction } from "mobx";
import type { ConnState, TmuxBridge } from "./bridge.ts";
import {
  SESSIONS_FORMAT,
  WINDOWS_FORMAT,
  PANES_FORMAT,
  SESSIONS_SUB,
  WINDOWS_SUB,
  PANES_SUB,
  encodeSnapshotLines,
} from "./snapshot-codec.ts";
import type { LogStore } from "./log-store.ts";
import type { TmuxModel } from "./tmux-model.ts";

// [LAW:one-source-of-truth] `ConnState` is owned by bridge.ts, where the
// connection state machine lives; re-exported (not redefined) so store.ts and
// any other consumer keep one definition that can't drift from the bridge's.
export type { ConnState } from "./bridge.ts";

export class ConnectionController {
  connState: ConnState = "connecting";

  // [LAW:no-ambient-temporal-coupling] Re-entrancy guard: the bridge can
  // re-enter "ready" (reconnect) while a prior install is still awaiting its
  // list-*/bootstrap round-trips. This owner runs at most one install at a
  // time so two invocations can't race redundant queries; a genuinely fresh
  // reconnect (after the prior install settled) still re-subscribes.
  private installing = false;

  constructor(
    private readonly client: TmuxBridge,
    private readonly model: TmuxModel,
    private readonly log: LogStore,
  ) {
    makeAutoObservable<this, "client" | "model" | "log" | "installing">(this, {
      client: false,
      model: false,
      log: false,
      installing: false,
    });
  }

  connect(url: string): void {
    // The transport's connect() is responsible for idempotency — e.g.
    // WebSocketBridge no-ops a second connect while a socket is already
    // OPEN/CONNECTING; transports that are already attached at construction
    // (Electron IPC) treat this as a no-op and ignore the URL.
    this.client.connect(url);
  }

  disconnect(): void {
    this.client.disconnect();
  }

  onStateChange(s: ConnState): void {
    this.connState = s;
    if (s === "ready") {
      void this.installSubscriptions();
    }
  }

  /**
   * Install the three tmux subscriptions that drive the entire model.
   * tmux pushes `%subscription-changed` events whenever the data changes,
   * so there is no need to ever poll after this.
   */
  private async installSubscriptions(): Promise<void> {
    if (this.installing) return;
    this.installing = true;
    try {
      await Promise.all([
        this.client.execute(
          `refresh-client -B ${SESSIONS_SUB}::${SESSIONS_FORMAT}`,
        ),
        this.client.execute(
          `refresh-client -B ${WINDOWS_SUB}::${WINDOWS_FORMAT}`,
        ),
        this.client.execute(`refresh-client -B ${PANES_SUB}::${PANES_FORMAT}`),
      ]);

      // [LAW:one-source-of-truth] The live model remains driven by the
      // subscription strings. Initial list-* snapshots are encoded into that
      // same string shape and fed through the same rebuild pipeline.
      const [sessionsResp, windowsResp, panesResp] = await Promise.all([
        this.client.execute(
          "list-sessions -F '#{session_id}|#{session_name}|#{session_attached}'",
        ),
        this.client.execute(
          "list-windows -a -F '#{session_id}|#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{window_zoomed_flag}'",
        ),
        this.client.execute(
          "list-panes -a -F '#{window_id}|#{pane_id}|#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_title}'",
        ),
      ]);

      runInAction(() => {
        if (sessionsResp.success) {
          this.model.applySnapshot(
            SESSIONS_SUB,
            encodeSnapshotLines(sessionsResp.output),
          );
        }
        if (windowsResp.success) {
          this.model.applySnapshot(
            WINDOWS_SUB,
            encodeSnapshotLines(windowsResp.output),
          );
        }
        if (panesResp.success) {
          this.model.applySnapshot(
            PANES_SUB,
            encodeSnapshotLines(panesResp.output),
          );
        }
      });

      // Bootstrap the "which session is OUR client attached to" field. In
      // practice tmux fires %client-session-changed on attach, but there's
      // no guarantee about timing relative to our subscriptions. Ask
      // explicitly so the UI has correct state from frame zero.
      const sessionResp = await this.client.execute(
        "display-message -p '#{session_id}'",
      );
      if (sessionResp.success && sessionResp.output[0] !== undefined) {
        const parsed = parseInt(sessionResp.output[0].replace(/^\$/, ""), 10);
        if (Number.isFinite(parsed)) {
          this.model.setClientSession(parsed);
        }
      }
    } catch (err) {
      this.log.pushError(
        `subscribe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.installing = false;
    }
  }

  get statusColor(): string {
    return this.connState === "ready"
      ? "teal"
      : this.connState === "open"
        ? "yellow"
        : this.connState === "closed"
          ? "red"
          : "gray";
  }
}
