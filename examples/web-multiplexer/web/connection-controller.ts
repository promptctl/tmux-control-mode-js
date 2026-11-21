// examples/web-multiplexer/web/connection-controller.ts
//
// ConnectionController — owns the connection state machine and the one-time
// work that must happen when the bridge reaches "ready": installing the three
// tmux format subscriptions that drive the entire model, seeding it with an
// initial list-* snapshot, and bootstrapping the attached-session pointer.
// Steady-state event routing is RefreshPolicy's job; this is only the
// lifecycle + bootstrap. [LAW:decomposition]

import { makeAutoObservable, runInAction } from "mobx";
import type { ConnectionState } from "@promptctl/tmux-control-mode-js/browser";
import type { TmuxBridge } from "./bridge.ts";
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

export class ConnectionController {
  // [LAW:single-enforcer] `onStateChange` is the ONE writer of the state — it
  // updates the state AND triggers installSubscriptions on "ready". Exposing a
  // public settable field would let a stray write flip to "ready" without the
  // install side-effect, so the field is private and read through a getter.
  // [LAW:one-source-of-truth] The library's ConnectionState, as the bridge
  // reports it: the closed reason and a refusal's error reach the UI whole.
  private _connectionState: ConnectionState = {
    status: "closed",
    reason: "disposed",
  };

  constructor(
    private readonly client: TmuxBridge,
    private readonly model: TmuxModel,
    private readonly log: LogStore,
  ) {
    makeAutoObservable<this, "client" | "model" | "log">(this, {
      client: false,
      model: false,
      log: false,
    });
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  // The bridge's connect() is idempotent while a connection is live.
  connect(): void {
    this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  onStateChange(s: ConnectionState): void {
    this._connectionState = s;
    if (s.status === "ready") {
      // Re-install on every "ready". A reconnect gives a NEW connection whose
      // server-side subscriptions must be re-established, so this must run
      // again — tmux keys subscriptions by name (a re-add replaces, not
      // duplicates), and the bridge's event handlers are wired once in
      // DemoStore, so a re-install never multiplies event delivery.
      void this.installSubscriptions();
    }
  }

  /**
   * Install the three tmux subscriptions that drive the entire model.
   * tmux pushes `%subscription-changed` events whenever the data changes,
   * so there is no need to ever poll after this.
   */
  private async installSubscriptions(): Promise<void> {
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
        this.model.applySnapshot(
          SESSIONS_SUB,
          encodeSnapshotLines(sessionsResp.output),
        );
        this.model.applySnapshot(
          WINDOWS_SUB,
          encodeSnapshotLines(windowsResp.output),
        );
        this.model.applySnapshot(
          PANES_SUB,
          encodeSnapshotLines(panesResp.output),
        );
      });

      // Bootstrap the "which session is OUR client attached to" field. In
      // practice tmux fires %client-session-changed on attach, but there's
      // no guarantee about timing relative to our subscriptions. Ask
      // explicitly so the UI has correct state from frame zero.
      const sessionResp = await this.client.execute(
        "display-message -p '#{session_id}'",
      );
      if (sessionResp.output[0] !== undefined) {
        const parsed = parseInt(sessionResp.output[0].replace(/^\$/, ""), 10);
        if (Number.isFinite(parsed)) {
          this.model.setClientSession(parsed);
        }
      }
    } catch (err) {
      this.log.pushError(
        `subscribe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  get statusColor(): string {
    const status = this._connectionState.status;
    return status === "ready"
      ? "teal"
      : status === "reconnecting"
        ? "yellow"
        : status === "closed"
          ? "red"
          : "gray";
  }
}
