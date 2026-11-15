// src/window-terminal/sizing/client-size.ts
//
// `ClientSizeDeclarer` — this terminal's claim on its window's size, sent to
// tmux as `refresh-client -C CxR` + `refresh-client -C @W:CxR` (declare) or
// `refresh-client -C @W:` (release).
//
// [LAW:single-enforcer] The one sender of a terminal's size commands: one in
//   flight at a time, the latest claim wins, and a claim equal to what tmux
//   already has is not sent again.
// [LAW:effects-at-boundaries] The claim is the solver's value; this sends it.
//
// Why the overall size too (F1, tmux 3.8): the first per-window declaration
// makes the control client a sizing client for EVERY window of its session
// from then on (`CLIENT_WINDOWSIZECHANGED`, never cleared; `resize.c
// ignore_client_size`), and a window it declared nothing for reads its tty
// size, 80x24 for a control client that never set one. Declaring the same
// grid as the client's size makes those windows read this browser's size —
// what any tmux client's other windows read — instead of an arbitrary 80x24.
// The overall size is the connection's: two terminals on one connection
// share it, and the last declaration wins, as it does for two terminals of
// one window.

import type { TmuxConnection, TmuxEventMap } from "../../browser.js";
import {
  clearWindowSize,
  isConnectionGone,
  setSize,
  setWindowSize,
} from "../../browser.js";
import { rethrowUnlessGone } from "../engine/pane-stream.js";
import { windowNumber, type WindowId } from "../ids.js";
import type { Grid, SizeClaim } from "./solve.js";

export interface ClientSizeDeclarerOptions {
  readonly connection: TmuxConnection;
  readonly windowId: WindowId;
  /** A size command tmux refused. A lost connection is not one. */
  readonly onError: (cause: unknown) => void;
}

export class ClientSizeDeclarer {
  private readonly connection: TmuxConnection;
  private readonly window: number;
  private readonly onError: (cause: unknown) => void;
  private wanted: SizeClaim = { kind: "hold" };
  // What tmux holds from this terminal: the grid last declared (sent, or in
  // flight), or null when nothing is.
  private declared: Grid | null = null;
  private inflight = false;
  private disposed = false;

  private readonly onConnectionState = (
    ev: TmuxEventMap["connection-state"],
  ): void => {
    // A connection that comes back may be a new tmux client (a bridge peer
    // re-joining), holding nothing this terminal declared before.
    if (ev.state.status !== "ready") this.declared = null;
  };

  constructor(opts: ClientSizeDeclarerOptions) {
    this.connection = opts.connection;
    this.window = windowNumber(opts.windowId);
    this.onError = opts.onError;
    this.connection.on("connection-state", this.onConnectionState);
  }

  apply(claim: SizeClaim): void {
    if (this.disposed) return;
    this.wanted = claim;
    this.pump();
  }

  /** Releases what this terminal declared, then sends nothing more. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connection.off("connection-state", this.onConnectionState);
    if (this.declared !== null) {
      this.declared = null;
      void clearWindowSize(this.connection, this.window).catch(
        rethrowUnlessGone,
      );
    }
  }

  private pump(): void {
    if (this.inflight || this.disposed) return;
    const claim = this.wanted;
    const send = this.next(claim);
    if (send === null) return;
    this.inflight = true;
    send.then(
      () => this.settled(),
      (err: unknown) => {
        // What tmux holds is unknown after a failure: claim nothing, and drop
        // the refused claim (unless a newer one replaced it) rather than
        // resend it; the next claim is sent whatever it is.
        this.declared = null;
        if (this.wanted === claim) this.wanted = { kind: "hold" };
        if (!isConnectionGone(err)) this.onError(err);
        this.settled();
      },
    );
  }

  private settled(): void {
    this.inflight = false;
    this.pump();
  }

  private next(claim: SizeClaim): Promise<unknown> | null {
    switch (claim.kind) {
      case "hold":
        return null;
      case "declare": {
        const { cols, rows } = claim.grid;
        if (this.declared?.cols === cols && this.declared.rows === rows) {
          return null;
        }
        this.declared = claim.grid;
        return Promise.all([
          setSize(this.connection, cols, rows),
          setWindowSize(this.connection, this.window, cols, rows),
        ]);
      }
      case "release":
        if (this.declared === null) return null;
        this.declared = null;
        return clearWindowSize(this.connection, this.window);
    }
  }
}
