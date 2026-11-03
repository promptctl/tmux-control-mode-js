// tests/integration/client.test.ts
// Integration tests for TmuxClient against a real tmux process.
//
// [LAW:verifiable-goals] Tests are gated behind TMUX_INTEGRATION=1 so CI does
// not fail when tmux is unavailable, but can be run explicitly to verify
// real-world behaviour against an actual tmux binary.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnTmux } from "../../src/transport/spawn.js";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import { TmuxClient } from "../../src/client.js";
import { WIRE_MESSAGE_TYPES } from "../../src/protocol/parser.js";
import type { TmuxEventMap } from "../../src/emitter.js";
import {
  listWindows,
  listPanes,
  listSessions,
  sendKeys,
  setSize,
  setPaneAction,
  subscribeRaw,
  unsubscribe,
  setFlags,
  clearFlags,
  queryClipboard,
  requestReport,
  capturePane,
} from "../../src/commands/index.js";
import { tmuxEscape } from "../../src/protocol/encoder.js";
import { paneScope, parsePaneListLine } from "../../src/pane-output.js";
import type { BytesSink } from "../../src/pane-output.js";
import { TmuxCommandError } from "../../src/errors.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import {
  REQUEST_REPORT_MIN_VERSION,
  meetsTmuxVersion,
  parseTmuxVersion,
} from "../../src/tmux-compat.js";
import type { ConnectionStateMessage } from "../../src/connection-state.js";

// [LAW:verifiable-goals] Gate every test behind the env var so the suite is
// opt-in only; skipping rather than failing keeps the default test run green
// regardless of whether tmux is installed in the environment.
const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// [LAW:verifiable-goals] Some refresh-client flags are newer than the
// library's 3.2 minimum: `-r` (requestReport) is rejected by tmux <3.5 as
// an unknown flag. Skip the feature test rather than asserting a contract
// the running tmux cannot honor.
// [LAW:one-source-of-truth] Version constants live in src/tmux-compat.ts;
// this gate imports them rather than restating the numbers.
const TMUX_SUPPORTS_REQUEST_REPORT = (() => {
  if (!RUN_INTEGRATION) return false;
  try {
    const version = parseTmuxVersion(execSync("tmux -V", { encoding: "utf8" }).trim());
    return version !== null && meetsTmuxVersion(version, REQUEST_REPORT_MIN_VERSION);
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
//
// Isolation: every test spawns its OWN tmux server via `-L <socket>`. This
// prevents ANY tmux invocation here — including `new-session`, `kill-session`,
// and the `-C` control-mode attach — from reaching the developer's default
// tmux server. Teardown delegates to the shared `killTmuxServer()` helper,
// which lists and kills every session on the isolated socket; tmux's
// exit-empty default then terminates the now-empty server.
//
// [LAW:single-enforcer] `tmuxCmd()` is the only place that builds the
// `tmux -L <socket> ...` command line in this file.
// [LAW:one-source-of-truth] Teardown itself lives in
// `tests/helpers/reap-test-sockets.ts` so it isn't re-implemented per file.

function uniqueSocket(prefix: string): string {
  return `tmux-js-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Generate a session name that is unique per test invocation. */
function uniqueSession(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function tmuxCmd(socketName: string, args: string): string {
  return `tmux -L ${socketName} ${args}`;
}

/**
 * Kill the isolated tmux server entirely. Best-effort; safe if already gone.
 * Used in afterEach so no isolated server (and no session in it) leaks.
 */
function killServer(socketName: string): void {
  killTmuxServer(socketName);
}

/**
 * Resolve once `client` reaches connection state "ready"; reject with a legible
 * message if it has not within `ms`. The single source of readiness-waiting —
 * `createSession` and `withSecondClient` both delegate here. A client that
 * never becomes ready (broken transport, hung tmux, stale socket) fails with a
 * named error and a cleaned-up handler, not an opaque suite timeout.
 * [LAW:one-source-of-truth] [LAW:no-silent-failure]
 */
function waitReady(client: TmuxClient, ms = 12000): Promise<void> {
  return new Promise((resolve, reject) => {
    const h = (e: ConnectionStateMessage) => {
      if (e.state.status !== "ready") return;
      clearTimeout(timer);
      client.off("connection-state", h);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off("connection-state", h);
      reject(new Error(`client did not reach ready state within ${ms}ms`));
    }, ms);
    client.on("connection-state", h);
  });
}

/**
 * Create a detached tmux session on an isolated socket and return a
 * TmuxClient attached to it, once its connectionState reaches "ready".
 *
 * Protocol detail: `attach-session` in control mode sends an unsolicited
 * startup %begin/%end pair before any user command's own guard block
 * (SPEC.md §5). TmuxClient consumes that pair internally and does not reach
 * "ready" until it closes (see TmuxClient.awaitingGreeting) — so waiting on
 * "ready" here is just observing the client's own lifecycle state, not a
 * workaround. Most callers don't actually need to wait at all: execute()
 * correlates correctly the instant a TmuxClient is constructed (see
 * "execute() issued synchronously..." below) — this helper waits anyway so
 * tests built on it get a clean, singular starting point.
 *
 * [LAW:dataflow-not-control-flow] Session creation and transport construction
 * always run unconditionally; variability lives in sessionName/socketName.
 */
async function createSession(
  socketName: string,
  sessionName: string,
): Promise<TmuxClient> {
  execSync(tmuxCmd(socketName, `new-session -d -s ${sessionName}`), {
    stdio: "ignore",
  });
  const client = new TmuxClient(
    spawnTmux(["attach-session", "-t", sessionName], { socketPath: socketName }),
  );
  // [LAW:one-source-of-truth] Readiness-waiting lives only in waitReady; this
  // delegates rather than re-implementing the connection-state handler, and so
  // inherits its legible timeout — a hung attach rejects (the caller's finally
  // still runs) instead of leaking the spawned child until the suite timeout.
  await waitReady(client);
  return client;
}

// ---------------------------------------------------------------------------
// 1. Command Correlation
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("Command Correlation", () => {
  let sessionName: string;
  // Sentinel + per-test reset: socketName is "" between tests so a beforeEach
  // that throws BEFORE assignment never makes afterEach run
  // `tmux -L <stale-or-undefined> list-sessions`/`kill-session` against an
  // unrelated tmux server (worst case: the user's real server, one
  // literally named `undefined`). The reset in afterEach below restores the
  // invariant per test — without it, a successful test would leave the
  // previous socket name visible to the next test's afterEach.
  let socketName = "";
  let client: TmuxClient;

  beforeEach(() => {
    socketName = uniqueSocket("corr");
  });

  afterEach(() => {
    client?.close();
    if (socketName !== "") killServer(socketName);
    socketName = "";
  });

  it(
    "execute(list-windows) resolves success with output",
    async () => {
      sessionName = uniqueSession("test-corr");
      client = await createSession(socketName, sessionName);

      const response: CommandResponse = await client.execute("list-windows");

      expect(response.success).toBe(true);
      expect(typeof response.commandNumber).toBe("number");
      expect(typeof response.timestamp).toBe("number");
      expect(Array.isArray(response.output)).toBe(true);
      // list-windows always produces at least one line for the initial window
      expect(response.output.length).toBeGreaterThan(0);
    },
    15000,
  );

  it(
    "execute() issued synchronously after construction correlates to its own response, not tmux's startup greeting",
    async () => {
      // Deliberately bypasses createSession()'s wait-for-ready: this proves
      // the client doesn't need it. If the startup greeting could still
      // steal a pending entry, `execute()` here would resolve with the
      // greeting's empty output (or hang, if the greeting is corrupted).
      sessionName = uniqueSession("test-corr");
      execSync(tmuxCmd(socketName, `new-session -d -s ${sessionName}`), {
        stdio: "ignore",
      });
      const transport = spawnTmux(["attach-session", "-t", sessionName], {
        socketPath: socketName,
      });
      client = new TmuxClient(transport);

      const response: CommandResponse = await client.execute("list-windows");

      expect(response.success).toBe(true);
      expect(response.output.length).toBeGreaterThan(0);
    },
    15000,
  );

  it(
    "execute(invalid-command-xyz) resolves with success: false",
    async () => {
      sessionName = uniqueSession("test-corr");
      client = await createSession(socketName, sessionName);

      // TmuxClient rejects with TmuxCommandError on %error. The original
      // CommandResponse is on err.response.
      const err = await client
        .execute("invalid-command-xyz")
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(TmuxCommandError);
      expect((err as TmuxCommandError).response.success).toBe(false);
    },
    15000,
  );

  it(
    "concurrent execute() calls all resolve (FIFO ordering)",
    async () => {
      sessionName = uniqueSession("test-corr");
      client = await createSession(socketName, sessionName);

      // [LAW:dataflow-not-control-flow] All three commands are enqueued
      // unconditionally; the FIFO queue decides when each resolves.
      const [r1, r2, r3] = await Promise.all([
        client.execute("list-windows"),
        client.execute("list-panes"),
        client.execute("list-windows"),
      ]);

      // All must resolve (not hang or reject)
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);

      // Each response carries the correlation fields
      for (const r of [r1, r2, r3]) {
        expect(typeof r.commandNumber).toBe("number");
        expect(typeof r.timestamp).toBe("number");
        expect(Array.isArray(r.output)).toBe(true);
      }
    },
    15000,
  );
});

// ---------------------------------------------------------------------------
// 1c. refresh-client surface (Phase 3 — SPEC §11, §13, §14, §15, §19)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("refresh-client surface", () => {
  let sessionName: string;
  let socketName = "";
  let client: TmuxClient | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("refresh");
  });

  afterEach(() => {
    client?.close();
    client = null;
    if (socketName !== "") killServer(socketName);
    socketName = "";
  });

  it(
    "setSize accepts a non-default size",
    async () => {
      sessionName = uniqueSession("test-size");
      client = await createSession(socketName, sessionName);
      const r = await setSize(client, 120, 40);
      expect(r.success).toBe(true);
    },
    15000,
  );

  it(
    "setPaneAction(paneId, 'on') succeeds",
    async () => {
      sessionName = uniqueSession("test-pane");
      client = await createSession(socketName, sessionName);
      // Default `list-panes` output starts with the pane index; use the
      // session-relative target form instead. Translate to a numeric pane id
      // by parsing the first %N occurrence in default list-panes output.
      const list = await client.execute("list-panes");
      expect(list.success).toBe(true);
      const match = list.output.join("\n").match(/%(\d+)/);
      expect(match).not.toBeNull();
      const paneId = parseInt(match![1], 10);
      const { PaneAction } = await import("../../src/protocol/types.js");
      const r = await setPaneAction(client, paneId, PaneAction.On);
      expect(r.success).toBe(true);
    },
    15000,
  );

  it(
    "subscribeRaw and unsubscribe each resolve with success",
    async () => {
      sessionName = uniqueSession("test-sub");
      client = await createSession(socketName, sessionName);
      const sub = await subscribeRaw(
        client,
        "test-sub-1",
        "",
        "#{pane_current_command}",
      );
      expect(sub.success).toBe(true);
      const unsub = await unsubscribe(client, "test-sub-1");
      expect(unsub.success).toBe(true);
    },
    15000,
  );

  it(
    "setFlags(['pause-after=2']) and clearFlags(['pause-after']) both succeed",
    async () => {
      sessionName = uniqueSession("test-flag");
      client = await createSession(socketName, sessionName);
      const setR = await setFlags(client, ["pause-after=2"]);
      expect(setR.success).toBe(true);
      const clearR = await clearFlags(client, ["pause-after"]);
      expect(clearR.success).toBe(true);
    },
    15000,
  );

  it(
    "queryClipboard returns a successful response",
    async () => {
      sessionName = uniqueSession("test-clip");
      client = await createSession(socketName, sessionName);
      const r = await queryClipboard(client);
      // Note: contents may be empty in a CI/headless environment; success is
      // about the protocol round-trip, not the clipboard payload.
      expect(r.success).toBe(true);
    },
    15000,
  );

  it.skipIf(!TMUX_SUPPORTS_REQUEST_REPORT)(
    "requestReport succeeds against an existing pane",
    async () => {
      sessionName = uniqueSession("test-rep");
      client = await createSession(socketName, sessionName);
      const list = await client.execute("list-panes");
      const match = list.output.join("\n").match(/%(\d+)/);
      expect(match).not.toBeNull();
      const paneId = parseInt(match![1], 10);
      const r = await requestReport(client, 
        paneId,
        "\u001b]11;rgb:1818/1818/1818\u001b\\",
      );
      expect(r.success).toBe(true);
    },
    15000,
  );

  it(
    "detach() causes tmux to send %exit and the transport to close",
    async () => {
      sessionName = uniqueSession("test-det");
      const c = await createSession(socketName, sessionName);
      client = c;
      const exitPromise = new Promise<void>((resolve) => {
        c.on("exit", () => resolve());
      });
      c.detach();
      await exitPromise;
      client = null;
    },
    15000,
  );
});

// ---------------------------------------------------------------------------
// 2. Lifecycle events
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("Lifecycle events", () => {
  let sessionName: string;
  let socketName = "";

  beforeEach(() => {
    socketName = uniqueSocket("life");
  });

  afterEach(() => {
    if (socketName !== "") killServer(socketName);
    socketName = "";
  });

  it(
    "exit event fires when transport is closed",
    async () => {
      sessionName = uniqueSession("test-lifecycle");
      const client = await createSession(socketName, sessionName);

      // Wrap the exit event in a promise so we can await it deterministically.
      const exitPromise = new Promise<void>((resolve) => {
        client.on("exit", () => resolve());
      });

      // Execute a command first to verify the client is live, then close.
      await client.execute("list-windows");
      client.close();

      // The exit event must fire within the timeout window.
      await exitPromise;
    },
    15000,
  );
});

// ---------------------------------------------------------------------------
// 3. Notification coverage (SPEC §23) — the conformance gate
//
// The README claim "the integration suite observes every SPEC §23 server→client
// event, or records an in-code exemption saying why it can't" is only true if a
// gate enforces it. Three representations of the §23 catalogue are reconciled at
// one seam so none can drift: the SPEC.md §23 table (doc), WIRE_MESSAGE_TYPES
// (the parser's dispatch keys), and the COVERAGE table below (the tests). A new
// §23 event, a dropped probe, or a stale coverage entry each redden the gate.
// [LAW:one-source-of-truth] [LAW:verifiable-goals] [FRAMING:representation]
// ---------------------------------------------------------------------------

/**
 * Create a window in a fresh side session, returning its target and id. tmux
 * picks a window notification's linked/unlinked variant by whether the window
 * is in the RECEIVING client's session, so probes that pin a variant act on a
 * window in a session the client is not attached to.
 */
function sideWindow(
  exec: ProbeCtx["exec"],
  prefix: string,
): { target: string; windowId: number } {
  const session = uniqueSession(prefix);
  // Session-qualified by name: a bare @id may resolve to the client's own
  // link of the window once it is linked into two sessions.
  const target = `${session}:side`;
  return {
    target,
    windowId: parseWindowId(
      exec(
        `new-session -d -s ${session} \\; ` +
          `new-window -d -P -F '#{window_id}' -n side -t ${session}`,
      ),
    ),
  };
}

/** Parse `@<n>` window-id output, failing loudly on anything else. */
function parseWindowId(out: string): number {
  const m = /^@(\d+)$/.exec(out.trim());
  if (m === null) {
    throw new Error(`expected a tmux window id, got ${JSON.stringify(out)}`);
  }
  return Number(m[1]);
}

/**
 * Resolve when `client` next emits a `type` event satisfying `match`; reject
 * with a legible message if none has within `ms`, so a missing notification
 * fails as "did not observe a matching %X"
 * rather than an opaque vitest timeout. The handler is registered synchronously,
 * so a caller that binds `const p = waitForEvent(...)` BEFORE provoking cannot
 * miss an event that fires between the two calls.
 * [LAW:no-ambient-temporal-coupling] Observation is armed before provocation.
 */
function waitForEvent<K extends keyof TmuxEventMap>(
  client: TmuxClient,
  type: K,
  match: (ev: TmuxEventMap[K]) => boolean = () => true,
  ms = 12000,
): Promise<TmuxEventMap[K]> {
  return new Promise((resolve, reject) => {
    const handler = (ev: TmuxEventMap[K]) => {
      if (!match(ev)) return;
      clearTimeout(timer);
      client.off(type, handler);
      resolve(ev);
    };
    const timer = setTimeout(() => {
      client.off(type, handler);
      reject(new Error(`did not observe a matching %${type} within ${ms}ms`));
    }, ms);
    client.on(type, handler);
  });
}

/**
 * Spawn a second control client attached to `sessionName` on `socketName`, run
 * `body` with it once ready, and always close it — even if `body` throws — so a
 * failing probe can never leak the spawned transport process.
 * [LAW:composability] One part owns the second-client lifecycle; probes borrow
 * it and never hand-manage cleanup.
 */
async function withSecondClient(
  socketName: string,
  sessionName: string,
  body: (c2: TmuxClient) => Promise<void>,
): Promise<void> {
  const c2 = new TmuxClient(
    spawnTmux(["attach-session", "-t", sessionName], { socketPath: socketName }),
  );
  try {
    await waitReady(c2);
    await body(c2);
  } finally {
    c2.close();
  }
}

/**
 * What a probe is handed: the attached control client plus the isolated
 * socket/session, so a probe can drive side channels (a second client, a
 * window in another session) on the SAME server. `exec` runs a raw tmux
 * command against the isolated socket.
 * [LAW:single-enforcer] Only the probe runner builds the tmux command line
 * (via tmuxCmd); probes ask for effects, they don't format sockets.
 */
interface ProbeCtx {
  readonly client: TmuxClient;
  readonly socketName: string;
  readonly sessionName: string;
  /** Run a tmux command on the probe's server; returns its stdout. */
  exec(args: string): string;
}

/**
 * Per §23 event: either a live probe that provokes it and resolves once it is
 * observed (rejecting otherwise), or an exemption naming why it cannot be
 * provoked deterministically from this harness. "Observed" is not a label — it
 * is backed by a probe that must actually fire the event, so the partition
 * cannot lie about what is verified.
 * [LAW:dataflow-not-control-flow] Coverage is data; the live tests are a
 * uniform projection of it, not a hand-maintained parallel list.
 */
type Coverage =
  | {
      readonly kind: "observed";
      readonly probe: (ctx: ProbeCtx) => Promise<void>;
    }
  | { readonly kind: "exempt"; readonly reason: string };

/**
 * The recorded §23 partition — the single source the README claim and the gate
 * both derive from. Keys are wire type-strings without the leading `%`. The
 * catalogue-integrity test asserts these keys equal SPEC.md §23 exactly, so a
 * `%name` cannot be silently dropped or invented here.
 * [LAW:one-source-of-truth]
 */
const COVERAGE: Readonly<Record<string, Coverage>> = {
  // Guard framing: every command round-trip emits %begin then %end; an invalid
  // command emits %error. These are the most-exercised events in the suite —
  // observed directly here, and pervasively by the Command Correlation tests.
  begin: {
    kind: "observed",
    probe: async ({ client }) => {
      const p = waitForEvent(client, "begin");
      await client.execute("list-windows");
      await p;
    },
  },
  end: {
    kind: "observed",
    probe: async ({ client }) => {
      const p = waitForEvent(client, "end");
      await client.execute("list-windows");
      await p;
    },
  },
  error: {
    kind: "observed",
    probe: async ({ client }) => {
      const p = waitForEvent(client, "error");
      // The invalid command must reject with TmuxCommandError (that IS the
      // %error round-trip). Rethrow anything else instead of swallowing it, so
      // an unexpected transport failure surfaces rather than hanging on `p`.
      // [LAW:no-silent-failure]
      await client.execute("this-is-not-a-command").then(
        () => {
          throw new Error("expected invalid command to emit %error");
        },
        (e: unknown) => {
          if (!(e instanceof TmuxCommandError)) throw e;
        },
      );
      await p;
    },
  },

  // Pane bytes flow through attachBytesSink, not the emitter, so %output is
  // observed via a sink rather than waitForEvent.
  output: {
    kind: "observed",
    probe: ({ client }) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          detach();
          reject(new Error("did not observe %output within 12000ms"));
        }, 12000);
        const detach = client.attachBytesSink({
          write(msg) {
            if (msg.data.byteLength === 0) return;
            clearTimeout(timer);
            detach();
            resolve();
          },
          end() {},
        });
        // If provocation fails, reject with the real error (clearing the timer
        // and sink) instead of hanging until the opaque %output timeout.
        // [LAW:no-silent-failure]
        client.execute("send-keys 'echo hello-output' Enter").catch(
          (e: unknown) => {
            clearTimeout(timer);
            detach();
            reject(e);
          },
        );
      }),
  },

  "window-add": {
    kind: "observed",
    probe: async ({ client }) => {
      const p = waitForEvent(client, "window-add");
      await client.execute("new-window");
      await p;
    },
  },
  "window-renamed": {
    kind: "observed",
    probe: async ({ client }) => {
      const p = waitForEvent(client, "window-renamed");
      await client.execute("rename-window renamed-target");
      await p;
    },
  },
  "window-pane-changed": {
    kind: "observed",
    probe: async ({ client }) => {
      await client.execute("split-window -h");
      const p = waitForEvent(client, "window-pane-changed");
      await client.execute("select-pane -t :.+");
      await p;
    },
  },
  "layout-change": {
    kind: "observed",
    probe: async ({ client }) => {
      const p = waitForEvent(client, "layout-change");
      await client.execute("split-window -h");
      await p;
    },
  },
  "unlinked-window-close": {
    kind: "observed",
    probe: async ({ client, exec }) => {
      // A window killed in ANOTHER session was never in this client's session.
      const { target, windowId } = sideWindow(exec, "cov-unlinkclose");
      const p = waitForEvent(
        client,
        "unlinked-window-close",
        (ev) => ev.windowId === windowId,
      );
      exec(`kill-window -t ${target}`);
      await p;
    },
  },
  "unlinked-window-add": {
    kind: "observed",
    probe: async ({ client, exec }) => {
      // A window created in ANOTHER session on the same server is unlinked from
      // this client's session, so it arrives as %unlinked-window-add.
      const other = uniqueSession("cov-unlinkadd");
      exec(`new-session -d -s ${other}`);
      const p = waitForEvent(client, "unlinked-window-add");
      exec(`new-window -d -t ${other}`);
      await p;
    },
  },
  "unlinked-window-renamed": {
    kind: "observed",
    probe: async ({ client, exec }) => {
      const other = uniqueSession("cov-unlinkren");
      exec(`new-session -d -s ${other}`);
      const p = waitForEvent(client, "unlinked-window-renamed");
      exec(`rename-window -t ${other} cov-unlinked-renamed`);
      await p;
    },
  },
  "sessions-changed": {
    kind: "observed",
    probe: async ({ client, exec }) => {
      const p = waitForEvent(client, "sessions-changed");
      exec(`new-session -d -s ${uniqueSession("cov-sesadd")}`);
      await p;
    },
  },
  "session-renamed": {
    kind: "observed",
    probe: async ({ client }) => {
      const p = waitForEvent(client, "session-renamed");
      await client.execute("rename-session cov-renamed");
      await p;
    },
  },
  "session-changed": {
    kind: "observed",
    probe: async ({ client, exec }) => {
      const other = uniqueSession("cov-sesswitch");
      exec(`new-session -d -s ${other}`);
      const p = waitForEvent(client, "session-changed");
      await client.execute(`switch-client -t ${other}`);
      await p;
    },
  },
  "session-window-changed": {
    kind: "observed",
    probe: async ({ client }) => {
      // Add a second window without switching, then move the session's current
      // window to it — that transition is %session-window-changed.
      await client.execute("new-window -d");
      const p = waitForEvent(client, "session-window-changed");
      await client.execute("next-window");
      await p;
    },
  },
  "client-session-changed": {
    kind: "observed",
    probe: async ({ client, socketName, sessionName, exec }) => {
      // %client-session-changed is sent to OTHER control clients when a client
      // switches session — the switching client itself gets %session-changed.
      // So a SECOND client must do the switching while the primary observes.
      const other = uniqueSession("cov-cliswitch");
      exec(`new-session -d -s ${other}`);
      await withSecondClient(socketName, sessionName, async (c2) => {
        const p = waitForEvent(client, "client-session-changed");
        await c2.execute(`switch-client -t ${other}`);
        await p;
      });
    },
  },
  "client-detached": {
    kind: "observed",
    probe: async ({ client, socketName, sessionName }) => {
      // Attach a SECOND control client to the same session; when it detaches,
      // the primary client observes %client-detached.
      await withSecondClient(socketName, sessionName, async (c2) => {
        const p = waitForEvent(client, "client-detached");
        c2.detach();
        await p;
      });
    },
  },
  "paste-buffer-changed": {
    kind: "observed",
    probe: async ({ client }) => {
      const p = waitForEvent(client, "paste-buffer-changed");
      await client.execute("set-buffer cov-buffer-content");
      await p;
    },
  },
  "paste-buffer-deleted": {
    kind: "observed",
    probe: async ({ client }) => {
      await client.execute("set-buffer -b cov-delbuf cov-x");
      const p = waitForEvent(client, "paste-buffer-deleted");
      await client.execute("delete-buffer -b cov-delbuf");
      await p;
    },
  },
  "subscription-changed": {
    kind: "observed",
    probe: async ({ client }) => {
      // Subscribing to a format makes the server emit its initial value as
      // %subscription-changed.
      const p = waitForEvent(client, "subscription-changed");
      await subscribeRaw(client, "cov-sub", "", "#{window_id}");
      await p;
    },
  },
  "pane-mode-changed": {
    kind: "observed",
    probe: async ({ client }) => {
      const p = waitForEvent(client, "pane-mode-changed");
      await client.execute("copy-mode");
      await p;
    },
  },
  message: {
    kind: "observed",
    probe: async ({ client, socketName, sessionName }) => {
      // A control client's OWN display-message returns as command output, not
      // %message. %message is delivered when ANOTHER actor displays a message
      // ON this client — so discover this client's name and target it from a
      // second client.
      const nameResp = await client.execute(
        "display-message -p '#{client_name}'",
      );
      const clientName = nameResp.output.join("").trim();
      if (clientName.length === 0) {
        throw new Error("could not resolve control client name for %message");
      }
      await withSecondClient(socketName, sessionName, async (c2) => {
        const p = waitForEvent(client, "message");
        await c2.execute(
          `display-message -c '${clientName}' cov-status-message`,
        );
        await p;
      });
    },
  },
  exit: {
    kind: "observed",
    probe: async ({ client }) => {
      const p = waitForEvent(client, "exit");
      client.detach();
      await p;
    },
  },
  "window-close": {
    kind: "observed",
    probe: async ({ client, exec, sessionName }) => {
      // Unlinking a window from another session while it stays linked in
      // this client's session is %window-close on every supported version.
      const { target, windowId } = sideWindow(exec, "cov-winclose");
      exec(`link-window -d -s ${target} -t ${sessionName}:`);
      const p = waitForEvent(
        client,
        "window-close",
        (ev) => ev.windowId === windowId,
      );
      exec(`unlink-window -t ${target}`);
      await p;
    },
  },

  // ---- Exemptions: not deterministically provokable from this harness ----
  // [LAW:no-silent-failure] Each records precisely WHY, so a green run never
  // overstates what was verified.
  "config-error": {
    kind: "exempt",
    reason:
      "Runtime `source-file` of a bad config emits %config-error only on newer tmux (observed on 3.6a, silent on the 3.4 baseline the CI/publish path runs). Startup config-load errors do fire on 3.4, but before a control client can attach — and a notification arriving inside the attach greeting's %begin/%end block is captured as greeting output, not dispatched. So it is not deterministically observable across the supported range (floor 3.2).",
  },
  pause: {
    kind: "exempt",
    reason:
      "Server→client %pause fires only when tmux measures THIS control client's output as more than `pause-after` seconds behind (backpressure). A promptly-draining transport never falls behind; forcing it requires artificially stalling reads, which is timing-dependent and flaky. The client→server pause/continue commands this responds to are covered by tests/integration/idle-pane-suppression.test.ts.",
  },
  continue: {
    kind: "exempt",
    reason:
      "Emitted only to resume a pane previously %pause'd by backpressure; unreachable without first provoking %pause (see the %pause exemption).",
  },
  "extended-output": {
    kind: "exempt",
    reason:
      "Emitted in place of %output only for a flow-controlled pane draining its backlog after a %pause; unreachable without first provoking %pause (see the %pause exemption).",
  },
};

/**
 * Parse the authoritative §23 server→client catalogue straight from SPEC.md so
 * the gate measures the tests against the spec itself, not a copy of it. Throws
 * loudly if the section or table can't be found or yields nothing — an empty
 * catalogue would make the coverage assertion vacuously pass, exactly the
 * can't-fail gate this epic exists to kill.
 * [LAW:one-source-of-truth] [LAW:no-silent-failure]
 */
function readSpec23ServerEvents(): ReadonlySet<string> {
  const spec = readFileSync(new URL("../../SPEC.md", import.meta.url), "utf8");
  const lines = spec.split("\n");
  const sectionIdx = lines.findIndex((l) => /^## 23\. /.test(l));
  if (sectionIdx === -1) throw new Error("SPEC.md §23 header not found");
  const tableIdx = lines.findIndex(
    (l, i) => i > sectionIdx && /^### Server-to-Client Messages/.test(l),
  );
  if (tableIdx === -1) {
    throw new Error("SPEC.md §23 Server-to-Client subsection not found");
  }
  const names = new Set<string>();
  for (let i = tableIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{2,3} /.test(line)) break; // next (sub)section ends the table
    // A data row names its event in the first cell: `| `%name` | … |`. Only
    // such rows are events; headers, separators, and blanks are skipped. A row
    // that opens like an event but whose name doesn't parse is a malformed
    // catalogue — fail loudly rather than drop it silently, which would let the
    // integrity cross-check surface only as a confusing downstream mismatch.
    // [LAW:no-silent-failure]
    if (!/^\|\s*`%/.test(line)) continue;
    const m = line.match(/^\|\s*`%([a-z0-9-]+)`/);
    if (m === null) {
      throw new Error(`SPEC.md §23 row has an unparseable event name: ${line}`);
    }
    names.add(m[1]);
  }
  if (names.size === 0) {
    throw new Error("SPEC.md §23 table yielded no server→client events");
  }
  return names;
}

// ---------------------------------------------------------------------------
// 3a. Structural conformance gate — pure, runs with or without tmux.
//
// This is the load-bearing claim: SPEC §23, the parser, and the coverage table
// describe the same set of events, and every event is either probed live or
// exempted with a reason. It needs no tmux, so it fails on a tmux-less CI host
// too. [LAW:verifiable-goals]
// ---------------------------------------------------------------------------

describe("SPEC §23 conformance gate (structural)", () => {
  const spec23 = [...readSpec23ServerEvents()].sort();

  it("catalogue integrity: SPEC §23 == parser wire types == coverage keys", () => {
    expect([...WIRE_MESSAGE_TYPES].sort()).toEqual(spec23);
    expect(Object.keys(COVERAGE).sort()).toEqual(spec23);
  });

  it("every §23 event is either observed live or exempted with a reason", () => {
    // Iterate the table itself — every entry's `cov` is defined by
    // construction, so there is no index-into-record undefined path. The
    // catalogue-integrity test above is the single enforcer that these keys
    // equal §23, so covering the table transitively covers every §23 event.
    // [LAW:single-enforcer]
    for (const [name, cov] of Object.entries(COVERAGE)) {
      // Exhaustive: kind is "observed" | "exempt". A non-empty reason is the
      // only thing an exemption may claim as its justification.
      if (cov.kind === "exempt") {
        expect(
          cov.reason.trim().length,
          `exemption for %${name} must cite a reason`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("README's stated partition matches the coverage table", () => {
    // [LAW:one-source-of-truth] The README count and named exemptions are a
    // representation of COVERAGE; this reconciles them so the prose cannot
    // become a hand-drifted approximation of what the gate actually verifies.
    const readme = readFileSync(
      new URL("../../README.md", import.meta.url),
      "utf8",
    );
    const observed = Object.values(COVERAGE).filter(
      (c) => c.kind === "observed",
    ).length;
    const exemptNames = Object.entries(COVERAGE).flatMap(([n, c]) =>
      c.kind === "exempt" ? [n] : [],
    );

    const m = readme.match(/(\d+) of the (\d+) events are observed live/);
    expect(
      m,
      "README must state '<N> of the <M> events are observed live'",
    ).not.toBeNull();
    expect(Number(m![1])).toBe(observed);
    expect(Number(m![2])).toBe(spec23.length);
    for (const name of exemptNames) {
      expect(
        readme.includes(`\`%${name}\``),
        `README must name the exempt event %${name}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3b. Live notification coverage — provokes each observed §23 event against a
// real tmux. Generated from COVERAGE so "observed" is proven, never asserted.
// ---------------------------------------------------------------------------

const OBSERVED_ENTRIES = Object.entries(COVERAGE).flatMap(([name, cov]) =>
  cov.kind === "observed" ? [[name, cov.probe] as const] : [],
);

describe.skipIf(!RUN_INTEGRATION)("Notification coverage (SPEC §23)", () => {
  it.each(OBSERVED_ENTRIES)(
    "observes %%%s live from a real tmux",
    async (name, probe) => {
      const socketName = uniqueSocket("cov");
      const sessionName = uniqueSession(`cov-${name}`);
      let client: TmuxClient | null = null;
      try {
        client = await createSession(socketName, sessionName);
        await probe({
          client,
          socketName,
          sessionName,
          exec: (args) =>
            execSync(tmuxCmd(socketName, args), {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }),
        });
      } finally {
        // Uniform cleanup for every probe, regardless of what it did to the
        // client — the runner stays unaware of any one probe's behavior.
        // [LAW:dataflow-not-control-flow] [LAW:locality-or-seam] This is safe
        // even for the `exit` probe, which detaches the client itself: close()
        // is idempotent (transport.close() → child.kill(), a no-op on an
        // already-exited process). [LAW:no-ambient-temporal-coupling]
        client?.close();
        killServer(socketName);
      }
    },
    20000,
  );

  // The COVERAGE probes pin each variant with cross-session setups; this pins
  // the common teardown path, whose variant tmux picks differently by version.
  it("an own-session kill-window emits a close event for that window", async () => {
    const socketName = uniqueSocket("cov");
    const sessionName = uniqueSession("cov-ownkill");
    let client: TmuxClient | null = null;
    try {
      const c = await createSession(socketName, sessionName);
      client = c;
      const windowId = parseWindowId(
        execSync(
          tmuxCmd(
            socketName,
            `new-window -d -P -F '#{window_id}' -t ${sessionName}`,
          ),
          { encoding: "utf8" },
        ),
      );
      const types = ["window-close", "unlinked-window-close"] as const;
      const closed = new Promise<void>((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          for (const t of types) c.off(t, handler);
        };
        const handler = (ev: { readonly windowId: number }) => {
          if (ev.windowId !== windowId) return;
          stop();
          resolve();
        };
        const timer = setTimeout(() => {
          stop();
          reject(new Error(`no close event for @${windowId} within 12000ms`));
        }, 12000);
        for (const t of types) c.on(t, handler);
      });
      await c.execute(`kill-window -t @${windowId}`);
      await closed;
    } finally {
      client?.close();
      killServer(socketName);
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// Free-function command surface (z31.3 acceptance)
//
// Verifies that listWindows, listPanes, and sendKeys — thin wrappers over
// TmuxConnection.execute() — produce correct responses against a real tmux.
// [LAW:types-are-the-program] Commands are free functions over TmuxConnection,
// not methods on TmuxClient. These tests type the client as TmuxConnection.
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("Free-function command surface", () => {
  let sessionName: string;
  let socketName = "";
  let client: TmuxClient | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("cmd");
  });

  afterEach(() => {
    client?.close();
    client = null;
    killServer(socketName);
    socketName = "";
  });

  it(
    "CMD-01: listWindows() returns structured WindowRecords with at least one entry",
    async () => {
      sessionName = uniqueSession("cmd-lw");
      client = await createSession(socketName, sessionName);

      // [LAW:types-are-the-program] Type the client as TmuxConnection — the
      // free function takes the minimal interface, not the full TmuxClient.
      const windows = await listWindows(client);

      // list-windows always has at least one entry (the initial window).
      expect(windows.length).toBeGreaterThan(0);
      const [w] = windows;
      expect(Number.isInteger(w.sessionId)).toBe(true);
      expect(w.sessionName).toBe(sessionName);
      expect(Number.isInteger(w.windowId)).toBe(true);
      expect(typeof w.windowName).toBe("string");
      expect(Number.isInteger(w.width)).toBe(true);
      expect(Number.isInteger(w.height)).toBe(true);
    },
    15000,
  );

  it(
    "CMD-02: listPanes() returns structured PaneRecords with at least one entry",
    async () => {
      sessionName = uniqueSession("cmd-lp");
      client = await createSession(socketName, sessionName);

      const panes = await listPanes(client);

      expect(panes.length).toBeGreaterThan(0);
      const [p] = panes;
      expect(Number.isInteger(p.sessionId)).toBe(true);
      expect(p.sessionName).toBe(sessionName);
      expect(Number.isInteger(p.windowId)).toBe(true);
      expect(typeof p.windowName).toBe("string");
      expect(Number.isInteger(p.paneId)).toBe(true);
      expect(typeof p.cwd).toBe("string");
      expect(p.cwd.length).toBeGreaterThan(0);
      expect(Number.isInteger(p.pid)).toBe(true);
      expect(typeof p.startCommand).toBe("string");
      expect(typeof p.currentCommand).toBe("string");
      expect(Number.isInteger(p.width)).toBe(true);
      expect(Number.isInteger(p.height)).toBe(true);
    },
    15000,
  );

  it(
    "CMD-02 regression (tmux-pane-detail-aha.fpf): listPanes() does not drop a pane whose cwd contains a literal tab or backslash",
    async () => {
      sessionName = uniqueSession("cmd-lp-tab");
      client = await createSession(socketName, sessionName);

      const weirdDir = `/tmp/tmux-js-test-tab-${Date.now()}-a\\b\tc`;
      mkdirSync(weirdDir, { recursive: true });
      try {
        // Created via tmux's own CLI (execSync), same as createSession
        // above, not as a control-mode command string: tmux's control-mode
        // command-line tokenizer is a separate, less-standard parser from
        // a POSIX shell's, and its handling of a literal tab inside a
        // quoted -c argument has been observed to vary by tmux version. A
        // CLI invocation hands tmux an already-tokenized argv element —
        // the shell's own (standard, stable) single-quote handling is the
        // only parser involved — so this avoids that variance entirely.
        execSync(
          tmuxCmd(
            socketName,
            `new-window -t ${sessionName} -n tabtest -c ${tmuxEscape(weirdDir)}`,
          ),
          { stdio: "ignore" },
        );
        // pane_current_path is queried live from the OS, not snapshotted at
        // spawn time: the window-creation command can return before the
        // forked child has finished its own chdir(), so an immediate query
        // can transiently read the inherited (parent) cwd under CI load —
        // observed as a flake in CI, never locally. Poll rather than
        // single-shot the read.
        const deadline = Date.now() + 8000;
        let found: Awaited<ReturnType<typeof listPanes>>[number] | undefined;
        for (;;) {
          const panes = await listPanes(client);
          found = panes.find(
            (p) => p.windowName === "tabtest" && p.cwd.includes("a\\b\tc"),
          );
          if (found !== undefined || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(found).toBeDefined();
        // Confirmed not dropped by the split-by-tab desync, and the cwd
        // decoded back to the literal backslash/tab it was created with —
        // not the escaped wire form, and not truncated at the tab.
        expect(found!.cwd).toContain("a\\b\tc");
      } finally {
        rmSync(weirdDir, { recursive: true, force: true });
      }
    },
    15000,
  );

  it(
    "CMD-03: listSessions() returns structured SessionRecords with at least one entry",
    async () => {
      sessionName = uniqueSession("cmd-ls");
      client = await createSession(socketName, sessionName);

      const sessions = await listSessions(client);

      expect(sessions.length).toBeGreaterThan(0);
      const session = sessions.find((s) => s.sessionName === sessionName);
      expect(session).toBeDefined();
      const s = session!;
      expect(Number.isInteger(s.sessionId)).toBe(true);
      expect(Number.isInteger(s.windowCount)).toBe(true);
      expect(s.windowCount).toBeGreaterThan(0);
      expect(typeof s.attached).toBe("boolean");
    },
    15000,
  );

  it(
    "CMD-03: sendKeys() delivers keystrokes that produce pane output",
    async () => {
      sessionName = uniqueSession("cmd-sk");
      client = await createSession(socketName, sessionName);

      // Identify the initial pane.
      const panesResp = await client.execute(
        "list-panes -a -F '#{pane_id} #{window_id} #{session_id}'",
      );
      const panes = panesResp.output.flatMap((line) => {
        const p = parsePaneListLine(line);
        return p !== null ? [p] : [];
      });
      expect(panes.length).toBeGreaterThan(0);
      const paneId = panes[0].paneId;

      // Attach a pane-scoped sink to capture bytes.
      const chunks: Uint8Array[] = [];
      const sink: BytesSink = {
        write(msg) {
          chunks.push(msg.data.slice());
        },
        end() {
          /* stateless */
        },
      };
      const dispose = client.attachBytesSink(sink, { scope: paneScope(paneId) });

      // sendKeys uses hex-byte encoding (-H) so special characters can't
      // be misinterpreted by tmux's string interpolation.
      await sendKeys(client, `%${paneId}`, "echo cmd-test-marker\r");

      // Wait until the marker string appears in the captured bytes.
      const decoder = new TextDecoder();
      const received = (): string =>
        chunks.map((c) => decoder.decode(c)).join("");
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const check = () => {
          if (received().includes("cmd-test-marker")) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error("timeout: cmd-test-marker not received"));
            return;
          }
          setTimeout(check, 5);
        };
        check();
      });

      dispose();
      expect(received()).toContain("cmd-test-marker");
    },
    15000,
  );

  it(
    "CMD-04: capturePane() returns the pane's full history as byte-faithful bytes with a matching line count",
    async () => {
      sessionName = uniqueSession("cmd-cap");
      client = await createSession(socketName, sessionName);

      const panesResp = await client.execute(
        "list-panes -a -F '#{pane_id} #{window_id} #{session_id}'",
      );
      const panes = panesResp.output.flatMap((line) => {
        const p = parsePaneListLine(line);
        return p !== null ? [p] : [];
      });
      expect(panes.length).toBeGreaterThan(0);
      const paneId = panes[0].paneId;

      // A marker with an embedded SGR colour escape, so -e's claim (escape
      // sequences, not just plain text) has something real to round-trip:
      // tmux re-emits the pane's current attributes as escape sequences
      // around the captured text.
      await sendKeys(
        client,
        `%${paneId}`,
        `printf '\\033[31mcapture-test-marker\\033[0m\\n'\r`,
      );

      // Wait for the actual rendered ESC byte, not just the marker text: the
      // still-unexecuted command line (typed but not yet run) also contains
      // the literal 4-character "\033" substring, which would otherwise
      // satisfy a plain text match before printf ever runs. Match the SGR
      // sequence loosely (`\x1b[` + any digits/semicolons + `31m`) rather
      // than the minimal `\x1b[31m` form: tmux's `-e` re-synthesis is not
      // guaranteed to emit the minimal form and commonly emits a compound
      // parameter list (e.g. `\x1b[0;31m`) depending on tmux
      // version/terminfo/active cell attributes.
      const redMarker = /\x1b\[[0-9;]*31mcapture-test-marker/;
      const decoder = new TextDecoder();
      const deadline = Date.now() + 8000;
      let capture: Awaited<ReturnType<typeof capturePane>> | undefined;
      for (;;) {
        capture = await capturePane(client, paneId);
        if (redMarker.test(decoder.decode(capture.bytes))) {
          break;
        }
        if (Date.now() >= deadline) {
          throw new Error("timeout: capture-test-marker not captured");
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      const text = decoder.decode(capture!.bytes);
      expect(text).toContain("capture-test-marker");
      // -e: the coloured marker survived capture with its SGR escape
      // sequence intact, not just the plain text.
      expect(text).toMatch(redMarker);
      // The one invariant join("\n") + lineCount must hold regardless of
      // pane geometry or shell prompt content: lineCount is exactly the
      // number of "\n"-separated lines actually present in bytes.
      expect(capture!.lineCount).toBe(text.split("\n").length);
    },
    15000,
  );
});
