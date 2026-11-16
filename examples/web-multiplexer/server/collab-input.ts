// examples/web-multiplexer/server/collab-input.ts
// CollabInput — the WRITE side of the collaborative pane: one dedicated
// server-side control client that injects every browser's keystrokes into the
// target pane via `sendKeyBytes`. The exact mirror image of `MirrorRegistry`'s
// read-only output tap: where the registry fans a pane's bytes OUT to N
// browsers, this fans N browsers' keystrokes IN to one pane.
//
// [LAW:decomposition] Output fan-out and input injection are different parts.
//   The registry stays read-only (its viewers are mute by type); this owner
//   holds the single write capability, so neither concern leaks into the other.
// [LAW:no-shared-mutable-globals] Single owner (the bridge constructs exactly
//   one), explicit API (`sendKeyBytes` / `close`), documented invariant: one shared
//   input client serves every collaborator, so tmux — not this class — is the
//   serialiser of concurrent keystrokes. No CRDT, no per-browser ordering.
// [LAW:no-ambient-temporal-coupling] Every keystroke goes to a client
//   `DedicatedControlClient.ready()` has settled (the cold-start race).

import { sendKeyBytes } from "@promptctl/tmux-control-mode-js";
import { asCommandResponse } from "../shared/command-response.js";
import { reportDetachedFailure } from "./detached-failure.js";
import {
  DedicatedControlClient,
  spawnDemoClient,
  type SpawnControlClient,
} from "./control-client.js";

export class CollabInput {
  private readonly connection: DedicatedControlClient;

  constructor(spawn: SpawnControlClient = spawnDemoClient) {
    // Keystrokes leave nothing behind on a lost connection; the next one
    // reaches tmux over a fresh client.
    this.connection = new DedicatedControlClient(
      "[collab]",
      () => undefined,
      spawn,
    );
  }

  /**
   * Inject `bytes` (raw terminal input from a browser) into pane `%paneId`.
   * They go out byte-for-byte via `send-keys -H`; tmux applies them to the
   * pane's pty and the result fans back to every browser through the mirror tap.
   *
   * A failed send (the pane closed between a keystroke and its delivery) is
   * surfaced as a server-side warning, not an error frame: the mirror channel
   * independently tells the collaborator the pane is `gone` and closes them, so
   * the lost keystroke needs no second signal. [LAW:no-silent-failure] the
   * failure is logged, never swallowed into a phantom success.
   *
   * Never rejects: the caller fires and forgets, so every other failure is
   * reported here too.
   */
  async sendKeyBytes(paneId: number, bytes: Uint8Array): Promise<void> {
    try {
      const client = await this.connection.ready();
      const response = await sendKeyBytes(client, `%${paneId}`, bytes).catch(
        asCommandResponse,
      );
      if (!response.success) {
        console.warn(`[collab] sendKeyBytes to %${paneId} failed`);
      }
    } catch (err) {
      reportDetachedFailure(`[collab] sendKeyBytes to %${paneId}`, err);
    }
  }

  /** Tear down the dedicated input client. */
  close(): void {
    this.connection.close();
  }
}
