// Shared scaffolding for the real-tmux integration suites.
//
// [LAW:one-source-of-truth] Each helper here used to be copied per test file,
// and a fix to one copy never reached the others (watch-server's detach test
// armed its observer after provoking the event, while client.test.ts's copy
// already armed first). Integration tests import these; they do not redeclare
// them.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { tmux } from "./tmux-cli.js";
import { spawnTmux } from "../../src/transport/spawn.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import {
  TmuxClient,
  type TmuxClientOptions,
  type TmuxConnection,
} from "../../src/client.js";
import type { TmuxEventMap } from "../../src/emitter.js";
import { paneNumber, parsePaneId } from "../../src/window-terminal/ids.js";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import { createWebSocketBridge } from "../../src/connectors/websocket/server.js";
import {
  WebSocketTmuxClient,
  type WebSocketTmuxClientOptions,
} from "../../src/connectors/websocket/client.js";
import type {
  BrowserWebSocketLike,
  ServerWebSocketLike,
} from "../../src/connectors/websocket/types.js";

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * A fresh `tmux -L` socket name. It lands in this run's own tmux namespace
 * (tests/helpers/reap-test-sockets.ts), so it needs no prefix to be reaped.
 */
export function uniqueSocket(tag: string): string {
  return `${tag}-${uniqueSuffix()}`;
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
  client: TmuxConnection,
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

/**
 * A transport that records into `sent` every command sent to tmux while
 * delegating to the real spawned transport.
 */
export function recordingTransport(
  inner: TmuxTransport,
  sent: string[],
): TmuxTransport {
  return {
    // [LAW:one-source-of-truth] `sent` means "accepted for delivery" — a
    // refused send (ok: false) never reached tmux, so it must not appear
    // here as if it did.
    send: (cmd) => {
      const result = inner.send(cmd);
      if (result.ok) sent.push(cmd);
      return result;
    },
    onData: (cb) => inner.onData(cb),
    onClose: (cb) => inner.onClose(cb),
    close: () => inner.close(),
  };
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

/** The numeric id of the client's current pane (`%N` → N). */
export async function getPrimaryPaneId(client: TmuxClient): Promise<number> {
  const r = await client.execute("display-message -p '#{pane_id}'");
  // [LAW:one-source-of-truth] The library's pane-id parser, not a local regex.
  return paneNumber(parsePaneId(r.output[0]));
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
  await readUntil(
    async () =>
      (await client.execute(`capture-pane -p -J -S - -t %${paneId}`)).output,
    (output) => output.some((line) => line.includes(text)),
    `waitForPaneText: %${paneId} never showed "${text}"`,
    ms,
  );
}

// Any value a read returns (circular, Map, bytes) renders. A long one keeps
// its end: reads that accumulate a stream hold the newest data last.
const QUOTE_LIMIT = 2000;
const quote = (value: unknown): string => {
  const shown = inspect(value, {
    depth: 4,
    maxArrayLength: Infinity,
    maxStringLength: Infinity,
  });
  return shown.length > QUOTE_LIMIT ? `…${shown.slice(-QUOTE_LIMIT)}` : shown;
};

/**
 * Call `read` until `done` holds for what it returns, and resolve with that;
 * reject as `what`, quoting the last value read, if none does within `ms`. A
 * rejection from `read` propagates.
 *
 * [LAW:one-source-of-truth] The one poll loop. A wait on state the test
 * already holds reads that state (`() => stream.state`), so a timeout quotes
 * what was observed, not just that a condition was false.
 */
export async function readUntil<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  what: string,
  ms = 8000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error(`${what} within ${ms}ms; last read: ${quote(value)}`);
    }
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

/**
 * A pane program that records the bytes its pty delivers: a raw tty (no line
 * discipline, no echo) copied by `cat` into a file. The check reads the file,
 * so no program's output buffering or terminal rendering stands between the
 * input and the assertion. The pane's command is `cat` once it is recording.
 */
export function rawInputCapture(): { command: string; hex: () => string } {
  const file = join(mkdtempSync(join(tmpdir(), "raw-input-")), "input");
  writeFileSync(file, "");
  return {
    command: `stty raw -echo; exec cat > '${file}'`,
    hex: () => hexBytes(readFileSync(file)),
  };
}

/** Bytes as space-separated two-digit hex, the form a capture is compared in. */
export function hexBytes(bytes: Iterable<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/**
 * A WebSocket bridge on a loopback port, whose connections `createClient`
 * backs, and a browser client of it, both torn down through `teardown`.
 * `sockets` holds every socket the browser opened, latest last.
 */
export async function browserOverBridge(
  createClient: () => TmuxClient,
  teardown: (() => unknown)[],
  options: Pick<WebSocketTmuxClientOptions, "reconnect"> = {},
): Promise<{ browser: WebSocketTmuxClient; sockets: WsClient[] }> {
  const bridge = createWebSocketBridge({ createClient });
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: "/tmux" });
  wss.on("connection", (ws, req) => {
    void bridge.handleConnection(ws as unknown as ServerWebSocketLike, {
      url: req.url,
      headers: {},
      remoteAddress: undefined,
    });
  });
  const port = await new Promise<number>((resolve) => {
    http.listen(0, "127.0.0.1", () => {
      const addr = http.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  teardown.push(async () => {
    await bridge.shutdown(1_000);
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => http.close(() => r()));
  });

  const sockets: WsClient[] = [];
  const browser = new WebSocketTmuxClient({
    url: `ws://127.0.0.1:${port}/tmux`,
    createWebSocket: (u) => {
      const ws = new WsClient(u);
      sockets.push(ws);
      return ws as unknown as BrowserWebSocketLike;
    },
    heartbeatIntervalMs: 0,
    ...options,
  });
  teardown.push(() => browser.close());
  return { browser, sockets };
}
