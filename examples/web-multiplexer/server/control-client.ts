// examples/web-multiplexer/server/control-client.ts
// One source of truth for spawning a dedicated server-side tmux control client
// against the demo's target and a promise for when it has SETTLED.
//
// THE COLD-START RACE (see tmux-showcase-bhx.14): the FIRST command issued on a
// freshly spawned `tmux -C` client can race the control-mode handshake — it may
// be written before tmux is ready to correlate it. Every dedicated client the
// demo stands up (the mirror's output tap, the collaborative input injector)
// must gate its first `execute`/`sendKeys` behind the same `ready` promise. That
// gate is identical for each, so it lives here once rather than copy-pasted into
// each owner. [LAW:one-source-of-truth] [LAW:no-ambient-temporal-coupling] the
// "settled before first command" ordering has a single, named owner.

import { TmuxClient, spawnTmux } from "@promptctl/tmux-control-mode-js";
import type { ConnectionState } from "@promptctl/tmux-control-mode-js";
import { demoAttachArgs } from "./tmux-target.js";

export interface ReadyControlClient {
  /** The control client — share it for the owner's lifetime, then `close()`. */
  readonly client: TmuxClient;
  /** Resolves once the client reaches `ready` (first byte from tmux). */
  readonly ready: Promise<void>;
}

/**
 * Spawn a `tmux -C` control client against the demo's target server and return
 * it alongside a promise that resolves when it is ready to take commands. The
 * caller owns the client's lifetime (`client.close()`).
 */
export function spawnReadyControlClient(): ReadyControlClient {
  const client = new TmuxClient(spawnTmux(demoAttachArgs()));
  const ready = new Promise<void>((resolve) => {
    if (client.connectionState.status === "ready") {
      resolve();
      return;
    }
    const onState = (ev: { state: ConnectionState }): void => {
      if (ev.state.status === "ready") {
        client.off("connection-state", onState);
        resolve();
      }
    };
    client.on("connection-state", onState);
  });
  return { client, ready };
}
