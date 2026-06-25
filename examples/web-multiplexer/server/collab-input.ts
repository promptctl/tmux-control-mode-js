// examples/web-multiplexer/server/collab-input.ts
// CollabInput — the WRITE side of the collaborative pane: one dedicated
// server-side control client that injects every browser's keystrokes into the
// target pane via `sendKeys`. The exact mirror image of `MirrorRegistry`'s
// read-only output tap: where the registry fans a pane's bytes OUT to N
// browsers, this fans N browsers' keystrokes IN to one pane.
//
// [LAW:decomposition] Output fan-out and input injection are different parts.
//   The registry stays read-only (its viewers are mute by type); this owner
//   holds the single write capability, so neither concern leaks into the other.
// [LAW:no-shared-mutable-globals] Single owner (the bridge constructs exactly
//   one), explicit API (`sendKeys` / `close`), documented invariant: one shared
//   input client serves every collaborator, so tmux — not this class — is the
//   serialiser of concurrent keystrokes. No CRDT, no per-browser ordering.
// [LAW:no-ambient-temporal-coupling] The first `sendKeys` gates on the client's
//   `ready` promise (the cold-start race), owned by `spawnReadyControlClient`.

import { sendKeys } from "@promptctl/tmux-control-mode-js";
import type { TmuxClient } from "@promptctl/tmux-control-mode-js";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import { spawnReadyControlClient } from "./control-client.js";

export class CollabInput {
  private client: TmuxClient | null = null;
  private ready: Promise<void> | null = null;
  private closed = false;

  /**
   * Inject `keys` (raw terminal input from a browser) into pane `%paneId`. The
   * keystrokes go out byte-for-byte via `send-keys -H`; tmux applies them to the
   * pane's pty and the result fans back to every browser through the mirror tap.
   *
   * A failed send (the pane closed between a keystroke and its delivery) is
   * surfaced as a server-side warning, not an error frame: the mirror channel
   * independently tells the collaborator the pane is `gone` and closes them, so
   * the lost keystroke needs no second signal. [LAW:no-silent-failure] the
   * failure is logged, never swallowed into a phantom success.
   */
  async sendKeys(paneId: number, keys: string): Promise<void> {
    if (this.closed) return;
    this.ensureClient();
    await this.ready;
    if (this.closed) return;
    const response = await sendKeys(this.client!, `%${paneId}`, keys).catch(
      (r: CommandResponse) => r,
    );
    if (!response.success) {
      console.warn(`[collab] sendKeys to %${paneId} failed`);
    }
  }

  /** Tear down the dedicated input client. */
  close(): void {
    this.closed = true;
    this.client?.close();
    this.client = null;
  }

  private ensureClient(): void {
    if (this.client === null) {
      const { client, ready } = spawnReadyControlClient();
      this.client = client;
      this.ready = ready;
    }
  }
}
