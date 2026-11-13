// Shared scaffolding for the real-tmux integration suites.
//
// [LAW:one-source-of-truth] Each helper here used to be copied per test file,
// and a fix to one copy never reached the others (watch-server's detach test
// armed its observer after provoking the event, while client.test.ts's copy
// already armed first). Integration tests import these; they do not redeclare
// them.

import { tmux } from "./tmux-cli.js";
import { spawnTmux } from "../../src/transport/spawn.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import { TmuxClient, type TmuxClientOptions } from "../../src/client.js";
import type { TmuxEventMap } from "../../src/emitter.js";
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

export { tmux };

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
 * Resolve once `client` is "ready" — and, with `startup`, once tmux's startup
 * `%session-changed` has also arrived. Reject at once on terminal "closed"
 * (before or after ready), naming the reason, rather than waiting out `ms`.
 * Every path clears the timer and both listeners.
 * [LAW:one-source-of-truth] The one ready/closed/timeout waiter; waitReady and
 * attachClient are its two uses.
 */
function waitConnected(
  client: TmuxClient,
  ms: number,
  startup: "await-startup" | "ready-only",
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let sawStartup = startup === "ready-only";
    const done = (err?: Error): void => {
      clearTimeout(timer);
      client.off("connection-state", onState);
      client.off("session-changed", onStartup);
      if (err) reject(err);
      else resolve();
    };
    const check = (): void => {
      const s = client.connectionState;
      if (s.status === "closed")
        done(new Error(`client closed before attach (reason: ${s.reason})`));
      else if (s.status === "ready" && sawStartup) done();
    };
    const onState = (): void => check();
    const onStartup = (): void => {
      sawStartup = true;
      check();
    };
    const timer = setTimeout(
      () =>
        done(
          new Error(
            `client not attached within ${ms}ms (status: ${client.connectionState.status}, startup session-changed: ${sawStartup})`,
          ),
        ),
      ms,
    );
    client.on("connection-state", onState);
    client.on("session-changed", onStartup);
    check();
  });
}

/**
 * Resolve once `client` is "ready" — at once if it already is. Reject at once
 * if it reaches terminal "closed" (a failed attach), naming the reason.
 */
export function waitReady(client: TmuxClient, ms = 12000): Promise<void> {
  return waitConnected(client, ms, "ready-only");
}

export interface ClientAttachOptions {
  readonly clientOptions?: TmuxClientOptions;
  /** Wrap the spawned transport, e.g. to record the commands sent through it. */
  readonly wrapTransport?: (inner: TmuxTransport) => TmuxTransport;
}

/**
 * Attach a control client to the existing `sessionName` on `socketName` and
 * resolve once it is ready AND tmux's startup `%session-changed` has arrived.
 * tmux sends that notification after the greeting that makes the client ready;
 * waiting for it keeps the notification itself (and the re-bootstrap
 * `list-panes` the router sends on it) out of the caller's test body. The
 * replies to the bootstrap commands, and any interest recompute they cause,
 * can still arrive after this resolves. A failed attach closes the
 * client before rejecting, so the spawned child never outlives the failure.
 * [LAW:single-enforcer] The one place an integration test attaches a client
 * through `attach-session` for use as a fixture; tests that exercise the
 * attach itself (connection-state, watch-server, client.test's synchronous
 * execute) build theirs by hand on purpose.
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
  try {
    // 8s: under vitest's 10s hook timeout (attachSession's new-session runs
    // first but takes milliseconds), so a hung attach fails with this
    // helper's named error and its cleanup, not vitest's generic timeout.
    await waitConnected(client, 8000, "await-startup");
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
  tmux(socketName, [
    "new-session",
    "-d",
    "-s",
    sessionName,
    ...newSessionFlags,
  ]);
  try {
    return await attachClient(socketName, sessionName, attach);
  } catch (err) {
    // The session is this helper's; a failed attach must not leave it (and,
    // via it, the isolated server) running. Best-effort: the session or
    // server may already be gone, and that must not replace `err`.
    try {
      tmux(socketName, ["kill-session", "-t", sessionName]);
    } catch {
      // Already gone is the outcome cleanup wanted; `err` is the signal.
    }
    throw err;
  }
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

/**
 * Resolve once one line of the pane's text contains `text`; reject, quoting
 * the last capture, if none does within `ms`. Reads plain text with wrapped
 * lines joined and history included (`capture-pane -p -J -S -`), so neither
 * the pane's width nor a shell that colours its output can split `text`.
 *
 * [LAW:no-ambient-temporal-coupling] The pane's own text is the authority on
 * "tmux has processed this", replacing a sleep that guesses how long the
 * pty round-trip takes. tmux serves `%output` and command replies over one
 * ordered stream: by the time this `capture-pane` reply parses, the `%output`
 * carrying the same bytes has already been parsed and dispatched to the
 * client's sinks.
 */
export async function waitForPaneText(
  client: TmuxClient,
  paneId: number,
  text: string,
  ms = 8000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { output } = await client.execute(
      `capture-pane -p -J -S - -t %${paneId}`,
    );
    if (output.some((line) => line.includes(text))) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForPaneText: %${paneId} never showed "${text}" within ${ms}ms; last capture: ${JSON.stringify(output)}`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, 10));
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
