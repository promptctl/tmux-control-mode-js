// src/client-size.ts
// The size of one tmux control client, as the claims of whoever shares it.
//
// tmux keeps one overall size and one size per window for a client
// (`refresh-client -C WxH`, `-C @W:WxH`). Many consumers can share one client
// — the terminals of a page, the pages behind a bridge — and each declares
// what it wants. [LAW:one-source-of-truth] The claims are the truth: tmux
// holds, for the overall size and for each window, the latest live claim,
// and the client counts toward window sizes exactly while some claim
// declares a size. A claim released — by a terminal that clears, or a page
// that left without clearing — leaves the sizes the other claims declared.
// tmux has no command that withdraws an overall size, so a released overall
// size stays until another claim sets one or no claim declares anything.
// A client spawned with `ignore-size` (watchServerArgs) never counts: its
// claims are recorded and sent, and the flag is never cleared.
//
// Measured on tmux 3.8: clearing `-C @W:` gives a window back to the other
// clients under `window-size latest`, but under `smallest` the client's
// overall size stays a ceiling (a control client that declared any size
// counts for its lifetime), and only the `ignore-size` flag takes it out.
//
// [LAW:no-ambient-temporal-coupling] Each change sends its commands as it
// runs, and the client sends commands in call order, so tmux applies the
// claims in the order they were recorded here.

import {
  refreshClientClearFlags,
  refreshClientClearWindowSize,
  refreshClientSetFlags,
  refreshClientSize,
  refreshClientWindowSize,
} from "./protocol/encoder.js";
import { emptyKeysResponse, type CommandResponse } from "./protocol/types.js";

/**
 * This client's size (`refresh-client -C`) as methods of the connection, so a
 * connection that shares one tmux client between many consumers can withdraw
 * a consumer's sizes when it goes away. `TmuxClient`, `WebSocketTmuxClient`
 * and the Electron renderer client all implement it.
 *
 * [LAW:single-enforcer] The client's {@link ClientSizeClaims} are the one
 * owner of its size; a `refresh-client -C` sent with `execute()` bypasses
 * them and outlives whoever sent it.
 */
export interface ClientSizeSurface {
  /**
   * Declare the overall size. tmux holds the latest claim's, and every window
   * no claim sized reads it.
   */
  setSize(width: number, height: number): Promise<CommandResponse>;
  /** Declare the size of window `@windowId`. */
  setWindowSize(
    windowId: number,
    width: number,
    height: number,
  ): Promise<CommandResponse>;
  /** Withdraw this claim's size for window `@windowId`. */
  clearWindowSize(windowId: number): Promise<CommandResponse>;
}

/** One consumer's share of a client's size. */
export interface ClientSizeClaim extends ClientSizeSurface {
  /** Withdraw every size this claim declared. */
  release(): Promise<CommandResponse>;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * What tmux is asked to hold: `client` null when no claim set an overall
 * size; `counts` whether the client takes part in window sizing.
 */
export interface SizeState {
  readonly counts: boolean;
  readonly client: Size | null;
  readonly windows: ReadonlyMap<number, Size>;
}

const NO_SIZE: SizeState = { counts: false, client: null, windows: new Map() };
const IGNORE_SIZE = ["ignore-size"] as const;

const same = (a: Size, b: Size | null | undefined): boolean =>
  a.width === b?.width && a.height === b.height;

/**
 * The commands that take tmux from `sent` to `wanted`, in the order tmux must
 * see them: into window sizing first, out of it last. tmux has no command
 * that withdraws an overall size, so a `client` gone null sends nothing;
 * `ignore-size` takes the client out once no size is declared at all.
 */
export function sizeCommands(sent: SizeState, wanted: SizeState): string[] {
  const commands: string[] = [];
  if (wanted.counts && !sent.counts) {
    commands.push(refreshClientClearFlags(IGNORE_SIZE));
  }
  if (wanted.client !== null && !same(wanted.client, sent.client)) {
    commands.push(refreshClientSize(wanted.client.width, wanted.client.height));
  }
  for (const [window, size] of wanted.windows) {
    if (!same(size, sent.windows.get(window))) {
      commands.push(refreshClientWindowSize(window, size.width, size.height));
    }
  }
  for (const window of sent.windows.keys()) {
    if (!wanted.windows.has(window)) {
      commands.push(refreshClientClearWindowSize(window));
    }
  }
  if (!wanted.counts && sent.counts) {
    commands.push(refreshClientSetFlags(IGNORE_SIZE));
  }
  return commands;
}

// The overall size or one window's. Each claim's token keys its entry in a
// target's slot, and a slot's entry with the highest `seq` is its latest
// live claim. A slot with no entries is deleted, so every slot holds one.
type Target = "client" | number;
type Token = object;
interface Entry {
  readonly size: Size;
  readonly seq: number;
}
type Slot = Map<Token, Entry>;

const latest = (slot: Slot): Size =>
  [...slot.values()].reduce((a, b) => (b.seq > a.seq ? b : a)).size;

export class ClientSizeClaims {
  private readonly slots = new Map<Target, Slot>();
  private seq = 0;
  private sent: SizeState = NO_SIZE;

  /**
   * @param ignoreSize the client was spawned with the `ignore-size` flag, so
   *   it never counts toward window sizing and the claims never clear it.
   */
  constructor(
    private readonly run: (command: string) => Promise<CommandResponse>,
    private readonly ignoreSize: boolean,
  ) {}

  claim(): ClientSizeClaim {
    const token: Token = {};
    return {
      setSize: (width, height) =>
        this.declare("client", token, { width, height }),
      setWindowSize: (windowId, width, height) =>
        this.declare(windowId, token, { width, height }),
      clearWindowSize: (windowId) => {
        this.put(windowId, token, undefined);
        return this.reconcile();
      },
      release: () => {
        for (const target of [...this.slots.keys()]) {
          this.put(target, token, undefined);
        }
        return this.reconcile();
      },
    };
  }

  /** Set `token`'s entry for `target`, or delete it (and an emptied slot). */
  private put(target: Target, token: Token, entry: Entry | undefined): void {
    const slot = this.slots.get(target) ?? new Map<Token, Entry>();
    if (entry === undefined) slot.delete(token);
    else slot.set(token, entry);
    if (slot.size === 0) this.slots.delete(target);
    else this.slots.set(target, slot);
  }

  private declare(
    target: Target,
    token: Token,
    size: Size,
  ): Promise<CommandResponse> {
    const before = this.slots.get(target)?.get(token);
    const entry: Entry = { size, seq: this.seq++ };
    this.put(target, token, entry);
    return this.reconcile().catch((err: unknown) => {
      // tmux refused the size, so it still holds what it held before: put
      // back this claim's earlier entry (unless a newer one replaced it) and
      // send what the claims say again.
      if (this.slots.get(target)?.get(token) === entry) {
        this.put(target, token, before);
      }
      // [LAW:no-silent-failure] exception: `err` is the failure, and it
      // reaches the caller below; a refusal of the re-send is that same
      // refusal again, or a connection already gone.
      void this.reconcile().catch(() => undefined);
      throw err;
    });
  }

  private reconcile(): Promise<CommandResponse> {
    const wanted = this.wanted();
    const commands = sizeCommands(this.sent, wanted);
    this.sent = wanted;
    return Promise.all(commands.map(this.run)).then(
      (responses) => responses.at(-1) ?? emptyKeysResponse(),
    );
  }

  private wanted(): SizeState {
    const windows = new Map<number, Size>();
    for (const [target, slot] of this.slots) {
      if (target !== "client") windows.set(target, latest(slot));
    }
    const overall = this.slots.get("client");
    return {
      counts: !this.ignoreSize && this.slots.size > 0,
      client: overall === undefined ? null : latest(overall),
      windows,
    };
  }
}
