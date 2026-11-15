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
  /** Declare the overall size, which every window this claim did not size reads. */
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

/** What tmux is asked to hold: `client` null when no claim set an overall size. */
export interface SizeState {
  readonly client: Size | null;
  readonly windows: ReadonlyMap<number, Size>;
}

const NO_SIZE: SizeState = { client: null, windows: new Map() };
const IGNORE_SIZE = ["ignore-size"] as const;

const counts = (s: SizeState): boolean =>
  s.client !== null || s.windows.size > 0;

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
  if (counts(wanted) && !counts(sent)) {
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
  if (!counts(wanted) && counts(sent)) {
    commands.push(refreshClientSetFlags(IGNORE_SIZE));
  }
  return commands;
}

// Each claim's token keys its entries. A Map keeps insertion order and a
// declaration re-inserts, so a slot's last entry is its latest live claim.
type Token = object;
type Slot = Map<Token, Size>;

function latest(slot: Slot): Size | null {
  let last: Size | null = null;
  for (const size of slot.values()) last = size;
  return last;
}

export class ClientSizeClaims {
  private readonly overall: Slot = new Map();
  private readonly windows = new Map<number, Slot>();
  private sent: SizeState = NO_SIZE;

  constructor(
    private readonly run: (command: string) => Promise<CommandResponse>,
  ) {}

  claim(): ClientSizeClaim {
    const token: Token = {};
    return {
      setSize: (width, height) =>
        this.declare(this.overall, token, { width, height }),
      setWindowSize: (windowId, width, height) =>
        this.declare(this.window(windowId), token, { width, height }),
      clearWindowSize: (windowId) => {
        this.windows.get(windowId)?.delete(token);
        return this.reconcile();
      },
      release: () => {
        this.overall.delete(token);
        for (const slot of this.windows.values()) slot.delete(token);
        return this.reconcile();
      },
    };
  }

  private window(windowId: number): Slot {
    const slot = this.windows.get(windowId) ?? new Map<Token, Size>();
    this.windows.set(windowId, slot);
    return slot;
  }

  private declare(
    slot: Slot,
    token: Token,
    size: Size,
  ): Promise<CommandResponse> {
    slot.delete(token);
    slot.set(token, size);
    return this.reconcile().catch((err: unknown) => {
      // tmux refused the claim, so it holds nothing from it: drop it (unless
      // a newer one replaced it) and send what the other claims say again.
      if (slot.get(token) === size) slot.delete(token);
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
    for (const [windowId, slot] of this.windows) {
      const size = latest(slot);
      // Every change reconciles, so this is the one place a window nobody
      // claims any more is forgotten.
      if (size === null) this.windows.delete(windowId);
      else windows.set(windowId, size);
    }
    return { client: latest(this.overall), windows };
  }
}
