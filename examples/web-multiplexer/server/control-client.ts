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
// THE CONNECTION'S LIFETIME: a client whose connection ends is dropped, and a
// `ready()` after the respawn delay spawns a fresh one, so the owner recovers
// when tmux comes back instead of holding a dead client until the bridge
// restarts. [LAW:single-enforcer] The end of a connection is reported here,
// once; the commands it took with it are not reported again
// (`detached-failure.ts`).

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

/**
 * How long an ended connection stands before `ready()` spawns again: with tmux
 * down, a collaborator holding a key would otherwise fork a `tmux -C` and log
 * its failure per keystroke.
 */
const RESPAWN_DELAY_MS = 1000;

interface Live {
  readonly kind: "live";
  readonly client: TmuxClient;
  readonly ready: Promise<TmuxClient>;
}

interface Ended {
  readonly kind: "ended";
  readonly error: TransportClosedError;
  readonly at: number;
}

export class DedicatedControlClient {
  private slot: Live | Ended | null = null;
  private closed = false;

  /**
   * `label` prefixes the warning logged when tmux ends the connection under a
   * live owner; `onLost` is how the owner drops whatever it built on that
   * connection.
   */
  constructor(
    private readonly label: string,
    private readonly onLost: () => void,
    private readonly spawn: SpawnControlClient,
  ) {}

  /**
   * The live client once it is ready for commands, spawning one if there is
   * none. Rejects with `TransportClosedError` if the connection ends before it
   * is ready, within `RESPAWN_DELAY_MS` of the last one ending, or once this
   * owner has closed.
   */
  ready(): Promise<TmuxClient> {
    if (this.closed) return Promise.reject(new TransportClosedError(undefined));
    const slot = this.slot;
    if (slot?.kind === "live") return slot.ready;
    if (slot !== null && Date.now() - slot.at < RESPAWN_DELAY_MS) {
      return Promise.reject(slot.error);
    }
    const live = this.connect();
    this.slot = live;
    // A transport that fails at once ends the client before its `exit` can be
    // heard (see `whenReady`), so an ending already reached is read here.
    if (live.client.connectionState.status === "closed") {
      this.end(live.client, undefined);
    }
    return live.ready;
  }

  /** Whether `client` is the live one: the client `ready()` hands out now. */
  isLive(client: TmuxClient): boolean {
    return this.slot?.kind === "live" && this.slot.client === client;
  }

  /** Close the live client for good; `ready()` refuses from now on. */
  close(): void {
    this.closed = true;
    const slot = this.slot;
    this.slot = null;
    if (slot?.kind === "live") slot.client.close();
  }

  private connect(): Live {
    const client = this.spawn();
    client.on("exit", ({ reason }) => this.end(client, reason));
    return { kind: "live", client, ready: whenReady(client) };
  }

  /** The live `client`'s connection has ended, with tmux's `reason` if any. */
  private end(client: TmuxClient, reason: string | undefined): void {
    // Our own `close()` has already let go of this client.
    if (!this.isLive(client)) return;
    this.slot = {
      kind: "ended",
      error: new TransportClosedError(reason),
      at: Date.now(),
    };
    // `exit` can come on tmux's `%exit` line, before the transport closes:
    // release the child rather than leave it to tmux.
    client.close();
    console.warn(
      `${this.label} tmux connection ended: ${reason ?? "no reason given"}`,
    );
    this.onLost();
  }
}

/**
 * `client` once it is ready for commands; rejects with `TransportClosedError`
 * if its connection ends first. [LAW:single-enforcer] The one definition of
 * "settled" for every client the demo server spawns (see THE COLD-START RACE).
 */
export function whenReady(client: TmuxClient): Promise<TmuxClient> {
  return new Promise<TmuxClient>((resolve, reject) => {
    // A client can settle before it is handed over: a transport that fails
    // at once ends it inside its constructor, and its `exit` has been and
    // gone by the time a listener could hear it.
    const state = client.connectionState;
    if (state.status === "ready") resolve(client);
    if (state.status === "closed") {
      reject(
        new TransportClosedError(
          state.reason === "refused" ? state.error.message : undefined,
        ),
      );
    }
    client.on("connection-state", ({ state }) => {
      if (state.status === "ready") resolve(client);
    });
    client.on("exit", ({ reason }) => reject(new TransportClosedError(reason)));
  });
}
