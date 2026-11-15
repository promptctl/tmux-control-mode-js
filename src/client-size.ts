// src/client-size.ts
// The size of one tmux control client, as the claims of whoever shares it.
//
// tmux keeps one overall size and one size per window for a client
// (`refresh-client -C WxH`, `-C @W:WxH`). Many consumers can share one client
// — the terminals of a page, the pages behind a bridge — and each declares
// what it wants. [LAW:one-source-of-truth] The claims are the truth: tmux
// holds, for the overall size and for each window, the latest live claim's,
// and the client counts toward window sizes exactly while some claim
// declares a size. A claim released — by a terminal that clears, or a page
// that left without clearing — leaves the sizes the other claims declared.
// tmux has no command that withdraws an overall size, so a released overall
// size stays until another claim sets one or no claim declares any size.
//
// Measured on tmux 3.8: clearing `-C @W:` gives a window back to the other
// clients under `window-size latest`, but under `smallest` the client's
// overall size stays a ceiling (a control client that declared any size
// counts for its lifetime), and only the `ignore-size` flag takes it out.
//
// [LAW:parse-dont-validate] tmux refuses a size only when a side is outside
// 1..10000 (cmd-refresh-client.c), and a claim refuses that size itself
// before recording it, so what the claims hold is what tmux accepts. (tmux
// 3.2 refuses every per-window form alike, so there too no command's fate
// depends on what was sent before it.) Each change therefore sends the
// difference between the claims just before it and just after it.
//
// [LAW:no-ambient-temporal-coupling] Each change sends its commands as it
// runs, and the client sends commands in call order, so tmux applies the
// claims in the order they were recorded here.

import { TmuxInvalidCommandError } from "./errors.js";
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
 * [LAW:single-enforcer] The client's claims are the one owner of its size; a
 * `refresh-client -C` sent with `execute()` bypasses them and outlives
 * whoever sent it.
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
  /** Withdraw every size this claim declared. The claim takes no more. */
  release(): Promise<CommandResponse>;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * What the claims ask tmux to hold: `client` null when no claim set an
 * overall size; `counts` whether the client takes part in window sizing.
 */
export interface SizeState {
  readonly counts: boolean;
  readonly client: Size | null;
  readonly windows: ReadonlyMap<number, Size>;
}

const IGNORE_SIZE = ["ignore-size"] as const;

// tmux's WINDOW_MINIMUM and WINDOW_MAXIMUM.
const SIDE_MIN = 1;
const SIDE_MAX = 10000;

const same = (a: Size, b: Size | null | undefined): boolean =>
  a.width === b?.width && a.height === b.height;

/**
 * The commands that take tmux from `before` to `after`, in the order tmux
 * must see them: into window sizing first, out of it last. tmux has no
 * command that withdraws an overall size, so a `client` gone null sends
 * nothing; `ignore-size` takes the client out once no size is declared.
 */
export function sizeCommands(before: SizeState, after: SizeState): string[] {
  const commands: string[] = [];
  if (after.counts && !before.counts) {
    commands.push(refreshClientClearFlags(IGNORE_SIZE));
  }
  if (after.client !== null && !same(after.client, before.client)) {
    commands.push(refreshClientSize(after.client.width, after.client.height));
  }
  for (const [window, size] of after.windows) {
    if (!same(size, before.windows.get(window))) {
      commands.push(refreshClientWindowSize(window, size.width, size.height));
    }
  }
  for (const window of before.windows.keys()) {
    if (!after.windows.has(window)) {
      commands.push(refreshClientClearWindowSize(window));
    }
  }
  if (!after.counts && before.counts) {
    commands.push(refreshClientSetFlags(IGNORE_SIZE));
  }
  return commands;
}

// The overall size or one window's. Each claim's token keys its entry in a
// target's slot; a Map keeps insertion order and a declaration re-inserts,
// so a slot's last entry is its latest live claim. A slot is deleted when
// its last entry is, so every slot holds at least one.
type Target = "client" | number;
type Token = object;
type Slot = Map<Token, Size>;

function latest(slot: Slot): Size {
  return [...slot.values()].reduce((_, size) => size);
}

function parseSize(command: string, width: number, height: number): Size {
  for (const side of [width, height]) {
    if (!Number.isInteger(side) || side < SIDE_MIN || side > SIDE_MAX) {
      throw new TmuxInvalidCommandError(
        command,
        `size ${String(width)}x${String(height)}: each side must be an integer in ${String(SIDE_MIN)}..${String(SIDE_MAX)}`,
      );
    }
  }
  return { width, height };
}

export class ClientSizeClaims {
  private readonly slots = new Map<Target, Slot>();

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
    let released = false;
    // [LAW:no-silent-failure] A released claim has no owner left to withdraw
    // what it would declare, so its use is refused rather than recorded.
    const change = (method: string, edit: () => void) =>
      released
        ? Promise.reject(
            new TmuxInvalidCommandError(method, "the size claim was released"),
          )
        : this.change(edit);
    return {
      setSize: (width, height) =>
        change("setSize", () => {
          const command = refreshClientSize(width, height);
          this.put("client", token, parseSize(command, width, height));
        }),
      setWindowSize: (windowId, width, height) =>
        change("setWindowSize", () => {
          const command = refreshClientWindowSize(windowId, width, height);
          this.put(windowId, token, parseSize(command, width, height));
        }),
      clearWindowSize: (windowId) =>
        change("clearWindowSize", () => this.drop(windowId, token)),
      release: () =>
        change("release", () => {
          released = true;
          for (const target of [...this.slots.keys()]) this.drop(target, token);
        }),
    };
  }

  private put(target: Target, token: Token, size: Size): void {
    const slot = this.slots.get(target) ?? new Map<Token, Size>();
    slot.delete(token);
    slot.set(token, size);
    this.slots.set(target, slot);
  }

  private drop(target: Target, token: Token): void {
    const slot = this.slots.get(target);
    slot?.delete(token);
    if (slot?.size === 0) this.slots.delete(target);
  }

  private change(edit: () => void): Promise<CommandResponse> {
    const before = this.state();
    try {
      edit();
    } catch (err) {
      return Promise.reject(err);
    }
    const commands = sizeCommands(before, this.state());
    return Promise.all(commands.map(this.run)).then(
      (responses) => responses.at(-1) ?? emptyKeysResponse(),
    );
  }

  private state(): SizeState {
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
