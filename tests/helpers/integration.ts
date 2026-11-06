// Shared scaffolding for the real-tmux integration suites.
//
// [LAW:one-source-of-truth] Each helper here used to be copied per test file,
// and a fix to one copy never reached the others (watch-server's detach test
// armed its observer after provoking the event, while client.test.ts's copy
// already armed first). Integration tests import these; they do not redeclare
// them.

import { execFileSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import { TmuxClient, type TmuxClientOptions } from "../../src/client.js";
import type { TmuxEventMap } from "../../src/emitter.js";
import type { ConnectionState } from "../../src/connection-state.js";
import type { TEST_SOCKET_PREFIXES } from "./reap-test-sockets.js";

/** A socket family the reaper collects; any other prefix would leak. */
export type TestSocketPrefix = (typeof TEST_SOCKET_PREFIXES)[number];

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * A fresh `tmux -L` socket name in `family`. Typing `family` from the reaper's
 * registry makes an unregistered prefix a compile error rather than a silent
 * leak. [LAW:types-are-the-program]
 */
export function uniqueSocket(family: TestSocketPrefix, tag: string): string {
  return `${family}${tag}-${uniqueSuffix()}`;
}

/** A session (or other tmux object) name unique per test invocation. */
export function uniqueName(tag: string): string {
  return `${tag}-${uniqueSuffix()}`;
}

/**
 * Resolve with the first `type` event `match` accepts; reject with a legible
 * message if none has within `ms`, so a missing event fails as "did not
 * observe a matching 'X' event" rather than an opaque vitest timeout. The handler is
 * registered synchronously, so a caller that binds `const p = waitForEvent(...)`
 * BEFORE provoking cannot miss an event that fires between the two calls.
 * [LAW:no-ambient-temporal-coupling] Observation is armed before provocation.
 */
export function waitForEvent<K extends keyof TmuxEventMap>(
  client: TmuxClient,
  type: K,
  match: (ev: TmuxEventMap[K]) => boolean = () => true,
  ms = 12000,
): Promise<TmuxEventMap[K]> {
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      client.off(type, handler);
      fn();
    };
    // A throwing matcher rejects this wait; it must not escape into the
    // client's emit loop. [LAW:no-silent-failure]
    const handler = (ev: TmuxEventMap[K]) => {
      let hit: boolean;
      try {
        hit = match(ev);
      } catch (err) {
        settle(() => reject(err));
        return;
      }
      if (hit) settle(() => resolve(ev));
    };
    const timer = setTimeout(() => {
      client.off(type, handler);
      reject(
        new Error(`did not observe a matching "${type}" event within ${ms}ms`),
      );
    }, ms);
    client.on(type, handler);
  });
}

/**
 * Resolve once `client` is "ready" — at once if it already is. Reject at once
 * if it reaches terminal "closed" (a failed attach), naming the reason, rather
 * than waiting out `ms`.
 */
export function waitReady(client: TmuxClient, ms = 8000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (s: ConnectionState): void => {
      if (s.status !== "ready" && s.status !== "closed") return;
      clearTimeout(timer);
      client.off("connection-state", handler);
      if (s.status === "ready") resolve();
      else
        reject(new Error(`client closed before ready (reason: ${s.reason})`));
    };
    const handler = (e: { state: ConnectionState }) => settle(e.state);
    const timer = setTimeout(() => {
      client.off("connection-state", handler);
      reject(new Error(`client did not reach ready state within ${ms}ms`));
    }, ms);
    client.on("connection-state", handler);
    settle(client.connectionState);
  });
}

export interface ClientAttachOptions {
  readonly clientOptions?: TmuxClientOptions;
  /** Wrap the spawned transport, e.g. to record the commands sent through it. */
  readonly wrapTransport?: (inner: TmuxTransport) => TmuxTransport;
}

/**
 * Attach a control client to the existing `sessionName` on `socketName` and
 * resolve once it is ready AND tmux's startup `%session-changed` has arrived.
 * tmux sends that notification after the greeting that makes the client
 * ready, and the router re-bootstraps on it; resolving at "ready" alone would
 * let both land inside the caller's test body. A failed attach rejects (closed
 * before ready, or a timeout) and closes the client first, so the spawned
 * child never outlives the failure.
 * [LAW:single-enforcer] The one place an integration test attaches a client.
 */
export async function attachClient(
  socketName: string,
  sessionName: string,
  { clientOptions, wrapTransport = (t) => t }: ClientAttachOptions = {},
): Promise<TmuxClient> {
  const client = new TmuxClient(
    wrapTransport(
      spawnTmux(["attach-session", "-t", sessionName], {
        socketPath: socketName,
      }),
    ),
    clientOptions,
  );
  // Armed before the first await: the startup notification can arrive in the
  // same chunk as the greeting.
  const startup = waitForEvent(client, "session-changed", () => true, 8000);
  try {
    await Promise.all([waitReady(client), startup]);
  } catch (err) {
    client.close();
    throw err;
  }
  return client;
}

/**
 * Create the detached session `sessionName` (with any extra `new-session`
 * flags) on `socketName`, then attach a ready client to it.
 */
export async function attachSession(
  socketName: string,
  sessionName: string,
  {
    newSessionFlags = [],
    ...attach
  }: ClientAttachOptions & {
    readonly newSessionFlags?: readonly string[];
  } = {},
): Promise<TmuxClient> {
  execFileSync(
    "tmux",
    [
      "-L",
      socketName,
      "new-session",
      "-d",
      "-s",
      sessionName,
      ...newSessionFlags,
    ],
    // stderr piped so a failed new-session's error carries tmux's reason.
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return attachClient(socketName, sessionName, attach);
}

/**
 * Attach a second control client to `sessionName` on `socketName`, run `body`
 * with it, and always close it — even if `body` throws — so a failing probe
 * can never leak the spawned transport process.
 * [LAW:composability] One part owns the second-client lifecycle; probes borrow
 * it and never hand-manage cleanup.
 */
export async function withSecondClient(
  socketName: string,
  sessionName: string,
  body: (c2: TmuxClient) => Promise<void>,
): Promise<void> {
  const c2 = await attachClient(socketName, sessionName);
  try {
    await body(c2);
  } finally {
    c2.close();
  }
}

/** Poll `pred` until it holds; reject if it has not within `ms`. */
export function pollUntil(pred: () => boolean, ms = 8000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + ms;
    const check = () => {
      let held: boolean;
      try {
        held = pred();
      } catch (err) {
        return reject(err);
      }
      if (held) return resolve();
      if (Date.now() >= deadline)
        return reject(new Error(`pollUntil: condition not met within ${ms}ms`));
      setTimeout(check, 5);
    };
    check();
  });
}
