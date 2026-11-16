// examples/web-multiplexer/server/control-client.ts
// One source of truth for the demo server's DEDICATED tmux control clients: the
// mirror's output tap and the collaborative input injector each own one for as
// long as the bridge runs, and tmux may restart under them in that time.
//
// THE COLD-START RACE (see tmux-showcase-bhx.14): the FIRST command issued on a
// freshly spawned `tmux -C` client can race the control-mode handshake — it may
// be written before tmux is ready to correlate it. Every command therefore goes
// to a client `ready()` has handed out, and `ready()` hands one out only once it
// has settled. [LAW:one-source-of-truth] [LAW:no-ambient-temporal-coupling] the
// "settled before first command" ordering has a single, named owner.
//
// THE CONNECTION'S LIFETIME: a client whose connection ends is dropped, and the
// next `ready()` spawns a fresh one, so the owner recovers when tmux comes back
// instead of holding a dead client until the bridge restarts. [LAW:single-enforcer]
// The end of a connection is reported here, once; the commands it took with it
// are not reported again (`detached-failure.ts`).

import {
  TmuxClient,
  TransportClosedError,
  spawnTmux,
} from "@promptctl/tmux-control-mode-js";
import { demoAttachArgs } from "./tmux-target.js";

/** Start a control client. Injectable so tests can run one over a fake transport. */
export type SpawnControlClient = () => TmuxClient;

/** A `tmux -C` client against the demo's target server. */
export const spawnDemoClient: SpawnControlClient = () =>
  new TmuxClient(spawnTmux(demoAttachArgs()));

interface Live {
  readonly client: TmuxClient;
  readonly ready: Promise<TmuxClient>;
}

export class DedicatedControlClient {
  private live: Live | null = null;
  private closed = false;

  /**
   * `label` prefixes the warning logged when tmux ends the connection under a
   * live owner; `onLost` is how the owner drops whatever it built on that
   * connection.
   */
  constructor(
    private readonly label: string,
    private readonly onLost: () => void,
    private readonly spawn: SpawnControlClient = spawnDemoClient,
  ) {}

  /**
   * The live client once it is ready for commands, spawning one if there is
   * none. Rejects with `TransportClosedError` if the connection ends before it
   * is ready, or once this owner has closed.
   */
  ready(): Promise<TmuxClient> {
    if (this.closed) return Promise.reject(new TransportClosedError(undefined));
    this.live ??= this.connect();
    return this.live.ready;
  }

  /** Close the live client for good; `ready()` refuses from now on. */
  close(): void {
    this.closed = true;
    const live = this.live;
    this.live = null;
    live?.client.close();
  }

  private connect(): Live {
    const client = this.spawn();
    const ready = new Promise<TmuxClient>((resolve, reject) => {
      client.on("connection-state", ({ state }) => {
        if (state.status === "ready") resolve(client);
      });
      client.on("exit", ({ reason }) => {
        reject(new TransportClosedError(reason));
        // Our own `close()` has already let go of this client.
        if (this.live?.client !== client) return;
        this.live = null;
        console.warn(
          `${this.label} tmux connection ended: ${reason ?? "no reason given"}`,
        );
        this.onLost();
      });
    });
    return { client, ready };
  }
}
