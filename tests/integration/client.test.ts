// tests/integration/client.test.ts
// Integration tests for TmuxClient against a real tmux process.
//
// [LAW:verifiable-goals] Tests are gated behind TMUX_INTEGRATION=1 so CI does
// not fail when tmux is unavailable, but can be run explicitly to verify
// real-world behaviour against an actual tmux binary.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnTmux } from "../../src/transport/spawn.js";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import {
  uniqueSocket,
  uniqueName,
  waitForEvent,
  withSecondClient,
  attachSession,
  tmux,
} from "../helpers/integration.js";
import { TmuxClient } from "../../src/client.js";
import { WIRE_MESSAGE_TYPES } from "../../src/protocol/parser.js";
import type { PaneRecord } from "../../src/protocol/types.js";
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
  newWindow,
  newEmptyWindow,
  respawnPane,
  paneCwd,
} from "../../src/commands/index.js";
import { tmuxEscape } from "../../src/protocol/encoder.js";
import { paneScope, parsePaneListLine } from "../../src/pane-output.js";
import type { BytesSink } from "../../src/pane-output.js";
import {
  TmuxCommandError,
  UnsupportedTmuxVersionError,
  PaneCwdUnavailableError,
} from "../../src/errors.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import {
  type TmuxVersion,
  MIN_TMUX_VERSION,
  REQUEST_REPORT_MIN_VERSION,
  QUERY_CLIPBOARD_MIN_VERSION,
  PASTE_BUFFER_NOTIFY_MIN_VERSION,
  MESSAGE_NOTIFY_MIN_VERSION,
  PANE_CWD_MIN_VERSION,
  EMPTY_WINDOW_MIN_VERSION,
  missingCwdFallback,
  meetsTmuxVersion,
} from "../../src/tmux-compat.js";
import { runningTmuxVersion } from "../helpers/running-tmux.js";

// [LAW:verifiable-goals] Gate every test behind the env var so the suite is
// opt-in only; skipping rather than failing keeps the default test run green
// regardless of whether tmux is installed in the environment.
const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// [LAW:verifiable-goals] Some features are newer than the library's 3.2
// minimum (e.g. `-r` for requestReport is rejected by tmux <3.5 as an unknown
// flag). Skip a feature test rather than asserting a contract the running
// tmux cannot honor.
// [LAW:one-source-of-truth] Version constants live in src/tmux-compat.ts;
// every gate here imports them rather than restating the numbers.
const RUNNING_TMUX_VERSION: TmuxVersion | null = RUN_INTEGRATION
  ? runningTmuxVersion()
  : null;

function tmuxAtLeast(need: TmuxVersion): boolean {
  return (
    RUNNING_TMUX_VERSION !== null &&
    meetsTmuxVersion(RUNNING_TMUX_VERSION, need)
  );
}

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
// Every tmux CLI call goes through the shared `tmux()` in
// tests/helpers/integration.ts.
// [LAW:one-source-of-truth] Teardown itself lives in
// `tests/helpers/reap-test-sockets.ts` so it isn't re-implemented per file.

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
    socketName = uniqueSocket("tmux-js-test-", "corr");
  });

  afterEach(() => {
    client?.close();
    if (socketName !== "") killTmuxServer(socketName);
    socketName = "";
  });

  it("execute(list-windows) resolves success with output", async () => {
    sessionName = uniqueName("test-corr");
    client = await attachSession(socketName, sessionName);

    const response: CommandResponse = await client.execute("list-windows");

    expect(response.success).toBe(true);
    expect(typeof response.commandNumber).toBe("number");
    expect(typeof response.timestamp).toBe("number");
    expect(Array.isArray(response.output)).toBe(true);
    // list-windows always produces at least one line for the initial window
    expect(response.output.length).toBeGreaterThan(0);
  }, 15000);

  it("execute() issued synchronously after construction correlates to its own response, not tmux's startup greeting", async () => {
    // Deliberately bypasses attachSession()'s wait-for-ready: this proves
    // the client doesn't need it. If the startup greeting could still
    // steal a pending entry, `execute()` here would resolve with the
    // greeting's empty output (or hang, if the greeting is corrupted).
    sessionName = uniqueName("test-corr");
    tmux(socketName, ["new-session", "-d", "-s", sessionName]);
    const transport = spawnTmux(["attach-session", "-t", sessionName], {
      socketPath: socketName,
    });
    client = new TmuxClient(transport);

    const response: CommandResponse = await client.execute("list-windows");

    expect(response.success).toBe(true);
    expect(response.output.length).toBeGreaterThan(0);
  }, 15000);

  it("execute(invalid-command-xyz) resolves with success: false", async () => {
    sessionName = uniqueName("test-corr");
    client = await attachSession(socketName, sessionName);

    // TmuxClient rejects with TmuxCommandError on %error. The original
    // CommandResponse is on err.response.
    const err = await client.execute("invalid-command-xyz").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TmuxCommandError);
    expect((err as TmuxCommandError).response.success).toBe(false);
  }, 15000);

  it("concurrent execute() calls all resolve (FIFO ordering)", async () => {
    sessionName = uniqueName("test-corr");
    client = await attachSession(socketName, sessionName);

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
  }, 15000);
});

// ---------------------------------------------------------------------------
// 1c. refresh-client surface (Phase 3 — SPEC §11, §13, §14, §15, §19)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("refresh-client surface", () => {
  let sessionName: string;
  let socketName = "";
  let client: TmuxClient | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("tmux-js-test-", "refresh");
  });

  afterEach(() => {
    client?.close();
    client = null;
    if (socketName !== "") killTmuxServer(socketName);
    socketName = "";
  });

  it("setSize accepts a non-default size", async () => {
    sessionName = uniqueName("test-size");
    client = await attachSession(socketName, sessionName);
    const r = await setSize(client, 120, 40);
    expect(r.success).toBe(true);
  }, 15000);

  it("setPaneAction(paneId, 'on') succeeds", async () => {
    sessionName = uniqueName("test-pane");
    client = await attachSession(socketName, sessionName);
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
  }, 15000);

  it("subscribeRaw and unsubscribe each resolve with success", async () => {
    sessionName = uniqueName("test-sub");
    client = await attachSession(socketName, sessionName);
    const sub = await subscribeRaw(
      client,
      "test-sub-1",
      "",
      "#{pane_current_command}",
    );
    expect(sub.success).toBe(true);
    const unsub = await unsubscribe(client, "test-sub-1");
    expect(unsub.success).toBe(true);
  }, 15000);

  it("setFlags(['pause-after=2']) and clearFlags(['pause-after']) both succeed", async () => {
    sessionName = uniqueName("test-flag");
    client = await attachSession(socketName, sessionName);
    const setR = await setFlags(client, ["pause-after=2"]);
    expect(setR.success).toBe(true);
    const clearR = await clearFlags(client, ["pause-after"]);
    expect(clearR.success).toBe(true);
  }, 15000);

  it.skipIf(!tmuxAtLeast(QUERY_CLIPBOARD_MIN_VERSION))(
    "queryClipboard returns a successful response",
    async () => {
      sessionName = uniqueName("test-clip");
      client = await attachSession(socketName, sessionName);
      const r = await queryClipboard(client);
      // Note: contents may be empty in a CI/headless environment; success is
      // about the protocol round-trip, not the clipboard payload.
      expect(r.success).toBe(true);
    },
    15000,
  );

  // Below 3.3 an ungated `refresh-client -l` makes the control client exit;
  // the gate must reject before sending, leaving the connection usable.
  it.skipIf(
    RUNNING_TMUX_VERSION === null || tmuxAtLeast(QUERY_CLIPBOARD_MIN_VERSION),
  )(
    "queryClipboard rejects below its floor and the connection survives",
    async () => {
      sessionName = uniqueName("test-clip-old");
      client = await attachSession(socketName, sessionName);
      await expect(queryClipboard(client)).rejects.toBeInstanceOf(
        UnsupportedTmuxVersionError,
      );
      const r = await client.execute("display-message -p ok");
      expect(r.output).toEqual(["ok"]);
    },
    15000,
  );

  it.skipIf(!tmuxAtLeast(REQUEST_REPORT_MIN_VERSION))(
    "requestReport succeeds against an existing pane",
    async () => {
      sessionName = uniqueName("test-rep");
      client = await attachSession(socketName, sessionName);
      const list = await client.execute("list-panes");
      const match = list.output.join("\n").match(/%(\d+)/);
      expect(match).not.toBeNull();
      const paneId = parseInt(match![1], 10);
      const r = await requestReport(
        client,
        paneId,
        "\u001b]11;rgb:1818/1818/1818\u001b\\",
      );
      expect(r.success).toBe(true);
    },
    15000,
  );

  it("detach() causes tmux to send %exit and the transport to close", async () => {
    sessionName = uniqueName("test-det");
    const c = await attachSession(socketName, sessionName);
    client = c;
    const exitPromise = waitForEvent(c, "exit");
    c.detach();
    await exitPromise;
    client = null;
  }, 15000);
});

// ---------------------------------------------------------------------------
// 2. Lifecycle events
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("Lifecycle events", () => {
  let sessionName: string;
  let socketName = "";

  beforeEach(() => {
    socketName = uniqueSocket("tmux-js-test-", "life");
  });

  afterEach(() => {
    if (socketName !== "") killTmuxServer(socketName);
    socketName = "";
  });

  it("exit event fires when transport is closed", async () => {
    sessionName = uniqueName("test-lifecycle");
    const client = await attachSession(socketName, sessionName);

    const exitPromise = waitForEvent(client, "exit");

    // Execute a command first to verify the client is live, then close.
    await client.execute("list-windows");
    client.close();

    // The exit event must fire within the timeout window.
    await exitPromise;
  }, 15000);
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
  const session = uniqueName(prefix);
  // Session-qualified by name: a bare @id may resolve to the client's own
  // link of the window once it is linked into two sessions.
  const target = `${session}:side`;
  return {
    target,
    windowId: parseWindowId(
      exec([
        "new-session",
        "-d",
        "-s",
        session,
        ";",
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-n",
        "side",
        "-t",
        session,
      ]),
    ),
  };
}

// [LAW:no-ambient-temporal-coupling] pane_current_path is the pane process's
// live cwd: until the forked child chdirs it is the server's (seen on Linux
// CI), so the read waits for the expected pane instead of racing the child.
// Only a non-matching listing retries; a listPanes rejection propagates.
async function waitForPane(
  client: TmuxClient,
  match: (pane: PaneRecord) => boolean,
): Promise<PaneRecord> {
  const panes = await waitUntil(
    () => listPanes(client),
    (listing) => listing.some(match),
  );
  return panes.find(match)!;
}

/**
 * Read until `done` accepts what was read. Only a value `done` refuses
 * retries; a rejected read propagates, and the timeout carries the last value.
 */
async function waitUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error(
        `not reached within 8000ms; last read: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The pane's captured text, once it contains `expected`. */
function waitForPaneText(
  client: TmuxClient,
  paneId: number,
  expected: string,
): Promise<string> {
  const decoder = new TextDecoder();
  return waitUntil(
    async () => decoder.decode((await capturePane(client, paneId)).bytes),
    (text) => text.includes(expected),
  );
}

/** One line of `format` for `target`, as tmux prints it. */
async function displayFormat(
  client: TmuxClient,
  target: string,
  format: string,
): Promise<string> {
  const reply = await client.execute(
    `display-message -p -t ${tmuxEscape(target)} ${tmuxEscape(format)}`,
  );
  return reply.output.join("\n");
}

/** The pane's exit status, once its process has exited and tmux kept it. */
async function waitForDeadPane(
  client: TmuxClient,
  paneId: number,
): Promise<string> {
  const state = await waitUntil(
    () =>
      displayFormat(client, `%${paneId}`, "#{pane_dead} #{pane_dead_status}"),
    (line) => line.startsWith("1 "),
  );
  return state.slice(2);
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
 * What a probe is handed: the attached control client plus the isolated
 * socket/session, so a probe can drive side channels (a second client, a
 * window in another session) on the SAME server. `exec` runs a tmux argv
 * against the isolated socket.
 * [LAW:single-enforcer] Only the probe runner wires `exec` (via the shared
 * tmux()); probes ask for effects, they don't format sockets.
 */
interface ProbeCtx {
  readonly client: TmuxClient;
  readonly socketName: string;
  readonly sessionName: string;
  /** Run a tmux command on the probe's server; returns its stdout. */
  exec(args: readonly string[]): string;
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
      /** Oldest tmux that emits the event; absent means the library floor. */
      readonly minVersion?: TmuxVersion;
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
        client
          .execute("send-keys 'echo hello-output' Enter")
          .catch((e: unknown) => {
            clearTimeout(timer);
            detach();
            reject(e);
          });
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
      // Real tmux output must parse: a checksum or grammar drift would turn
      // every layout into the malformed arm without failing the key-set check.
      const paneIds = async () =>
        (await client.execute("list-panes -F '#{pane_id}'")).output
          .map((l) => Number(l.trim().slice(1)))
          .sort();
      const before = (await paneIds()).length;
      // A malformed layout resolves at once so its reason is reported, not
      // hidden behind the wait timeout.
      const p = waitForEvent(
        client,
        "layout-change",
        (ev) =>
          ev.layout.kind === "malformed" ||
          ev.layout.panes.length === before + 1,
      );
      await client.execute("split-window -h");
      const ev = await p;
      const after = await paneIds();
      expect(ev.layout).toMatchObject({ kind: "parsed" });
      expect(
        ev.layout.kind === "parsed" &&
          ev.layout.panes.map((g) => g.paneId).sort(),
      ).toEqual(after);
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
      exec(["kill-window", "-t", target]);
      await p;
    },
  },
  "unlinked-window-add": {
    kind: "observed",
    probe: async ({ client, exec }) => {
      // A window created in ANOTHER session on the same server is unlinked from
      // this client's session, so it arrives as %unlinked-window-add.
      const other = uniqueName("cov-unlinkadd");
      exec(["new-session", "-d", "-s", other]);
      const p = waitForEvent(client, "unlinked-window-add");
      exec(["new-window", "-d", "-t", other]);
      await p;
    },
  },
  "unlinked-window-renamed": {
    kind: "observed",
    probe: async ({ client, exec }) => {
      const other = uniqueName("cov-unlinkren");
      exec(["new-session", "-d", "-s", other]);
      const p = waitForEvent(client, "unlinked-window-renamed");
      exec(["rename-window", "-t", other, "cov-unlinked-renamed"]);
      await p;
    },
  },
  "sessions-changed": {
    kind: "observed",
    probe: async ({ client, exec }) => {
      const p = waitForEvent(client, "sessions-changed");
      exec(["new-session", "-d", "-s", uniqueName("cov-sesadd")]);
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
      const other = uniqueName("cov-sesswitch");
      exec(["new-session", "-d", "-s", other]);
      const p = waitForEvent(
        client,
        "session-changed",
        (e) => e.name === other,
      );
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
      const other = uniqueName("cov-cliswitch");
      // Match the switch by its target session: c2's own attach also sends
      // the primary a %client-session-changed, and it can arrive late.
      const otherId = Number(
        exec([
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{session_id}",
          "-s",
          other,
        ]).slice(1),
      );
      await withSecondClient(socketName, sessionName, async (c2) => {
        const p = waitForEvent(
          client,
          "client-session-changed",
          (e) => e.sessionId === otherId,
        );
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
    minVersion: PASTE_BUFFER_NOTIFY_MIN_VERSION,
    probe: async ({ client }) => {
      const p = waitForEvent(client, "paste-buffer-changed");
      await client.execute("set-buffer cov-buffer-content");
      await p;
    },
  },
  "paste-buffer-deleted": {
    kind: "observed",
    minVersion: PASTE_BUFFER_NOTIFY_MIN_VERSION,
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
    minVersion: MESSAGE_NOTIFY_MIN_VERSION,
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
      exec(["link-window", "-d", "-s", target, "-t", `${sessionName}:`]);
      const p = waitForEvent(
        client,
        "window-close",
        (ev) => ev.windowId === windowId,
      );
      exec(["unlink-window", "-t", target]);
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
  cov.kind === "observed"
    ? [[name, cov.probe, cov.minVersion ?? MIN_TMUX_VERSION] as const]
    : [],
);

describe.skipIf(!RUN_INTEGRATION)("Notification coverage (SPEC §23)", () => {
  // An event newer than the running tmux is skipped, not failed: that tmux
  // cannot emit it, and the skip shows in the run rather than vanishing.
  for (const [name, probe, minVersion] of OBSERVED_ENTRIES)
    it.skipIf(!tmuxAtLeast(minVersion))(
      `observes %${name} live from a real tmux`,
      async () => {
        const socketName = uniqueSocket("tmux-js-test-", "cov");
        const sessionName = uniqueName(`cov-${name}`);
        let client: TmuxClient | null = null;
        try {
          client = await attachSession(socketName, sessionName);
          await probe({
            client,
            socketName,
            sessionName,
            exec: (args) => tmux(socketName, args),
          });
        } finally {
          // Uniform cleanup for every probe, regardless of what it did to the
          // client — the runner stays unaware of any one probe's behavior.
          // [LAW:dataflow-not-control-flow] [LAW:locality-or-seam] This is safe
          // even for the `exit` probe, which detaches the client itself: close()
          // is idempotent (transport.close() → child.kill(), a no-op on an
          // already-exited process). [LAW:no-ambient-temporal-coupling]
          client?.close();
          killTmuxServer(socketName);
        }
      },
      20000,
    );

  // The COVERAGE probes pin each variant with cross-session setups; this pins
  // the common teardown path, whose variant tmux picks differently by version.
  it("an own-session kill-window emits a close event for that window", async () => {
    const socketName = uniqueSocket("tmux-js-test-", "cov");
    const sessionName = uniqueName("cov-ownkill");
    let client: TmuxClient | null = null;
    try {
      const c = await attachSession(socketName, sessionName);
      client = c;
      const windowId = parseWindowId(
        tmux(socketName, [
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{window_id}",
          "-t",
          sessionName,
        ]),
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
      killTmuxServer(socketName);
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
    socketName = uniqueSocket("tmux-js-test-", "cmd");
  });

  afterEach(() => {
    client?.close();
    client = null;
    killTmuxServer(socketName);
    socketName = "";
  });

  it("CMD-01: listWindows() returns structured WindowRecords with at least one entry", async () => {
    sessionName = uniqueName("cmd-lw");
    client = await attachSession(socketName, sessionName);

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
  }, 15000);

  it("CMD-02: listPanes() returns structured PaneRecords with at least one entry", async () => {
    sessionName = uniqueName("cmd-lp");
    client = await attachSession(socketName, sessionName);

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
  }, 15000);

  it("CMD-02 regression (tmux-pane-detail-aha.fpf): listPanes() does not drop a pane whose cwd contains a literal tab or backslash", async () => {
    sessionName = uniqueName("cmd-lp-tab");
    client = await attachSession(socketName, sessionName);

    const weirdDir = `/tmp/tmux-js-test-tab-${Date.now()}-a\\b\tc`;
    mkdirSync(weirdDir, { recursive: true });
    try {
      // Created via tmux's own CLI, not as a control-mode command string:
      // tmux's control-mode tokenizer's handling of a literal tab inside a
      // quoted -c argument has been observed to vary by tmux version. The
      // CLI receives weirdDir as one argv element, so no tokenizer splits it
      // (tmux still format-expands -c; weirdDir has no `#`).
      tmux(socketName, [
        "new-window",
        "-t",
        sessionName,
        "-n",
        "tabtest",
        "-c",
        weirdDir,
      ]);
      // Found at all means not dropped by the split-by-tab desync, and the
      // cwd decoded back to the literal backslash/tab it was created with —
      // not the escaped wire form, and not truncated at the tab.
      await waitForPane(
        client,
        (p) => p.windowName === "tabtest" && p.cwd.includes("a\\b\tc"),
      );
    } finally {
      rmSync(weirdDir, { recursive: true, force: true });
    }
  }, 15000);

  it("CMD-03: listSessions() returns structured SessionRecords with at least one entry", async () => {
    sessionName = uniqueName("cmd-ls");
    client = await attachSession(socketName, sessionName);

    const sessions = await listSessions(client);

    expect(sessions.length).toBeGreaterThan(0);
    const session = sessions.find((s) => s.sessionName === sessionName);
    expect(session).toBeDefined();
    const s = session!;
    expect(Number.isInteger(s.sessionId)).toBe(true);
    expect(Number.isInteger(s.windowCount)).toBe(true);
    expect(s.windowCount).toBeGreaterThan(0);
    expect(typeof s.attached).toBe("boolean");
  }, 15000);

  it("CMD-03: sendKeys() delivers keystrokes that produce pane output", async () => {
    sessionName = uniqueName("cmd-sk");
    client = await attachSession(socketName, sessionName);

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
  }, 15000);

  it("CMD-04: capturePane() returns the pane's full history as byte-faithful bytes with a matching line count", async () => {
    sessionName = uniqueName("cmd-cap");
    client = await attachSession(socketName, sessionName);

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
    // eslint-disable-next-line no-control-regex -- the ESC byte is what tmux's -e capture emits
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
  }, 15000);

  it("CMD-05: newWindow() creates a window in a non-attached session with the given cwd and command, returning its pane id", async () => {
    sessionName = uniqueName("cmd-nw");
    client = await attachSession(socketName, sessionName);
    const target = uniqueName("cmd-nw-target");
    await client.execute(`new-session -d -s ${tmuxEscape(target)}`);
    // realpath: macOS /var/folders is a symlink to /private/var/folders,
    // and tmux reports the resolved path. '#S' in the name: tmux format-
    // expands -c, so an unescaped cwd would land elsewhere.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "nw-#S-")));

    try {
      const created = await newWindow(client, {
        session: target,
        cwd,
        command: "sleep 60",
      });

      const pane = await waitForPane(
        client,
        (p) => p.paneId === created.paneId && p.cwd === cwd,
      );
      expect(pane).toMatchObject({
        sessionName: target,
        windowId: created.windowId,
      });
      // tmux reports the start command re-quoted from its argv ("sleep 60").
      expect(pane.startCommand).toContain("sleep 60");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  // The missing name is a prefix of a live session: tmux's inexact matching
  // would put the window there, so this pins newWindow's exact targeting.
  it("CMD-05: newWindow() rejects with tmux's error text for a nonexistent session, even one prefixing a live session", async () => {
    sessionName = uniqueName("cmd-nw-nosess");
    client = await attachSession(socketName, sessionName);

    const windowsBefore = (await listWindows(client)).length;
    const attempt = newWindow(client, {
      session: sessionName.slice(0, -1),
      cwd: tmpdir(),
    });
    await expect(attempt).rejects.toBeInstanceOf(TmuxCommandError);
    await expect(attempt).rejects.toThrow(/can't find session/);
    expect(await listWindows(client)).toHaveLength(windowsBefore);
  }, 15000);

  // Pins tmux's behavior newWindow documents rather than hides: a cwd that
  // does not exist does not fail new-window; the pane starts in $HOME, or on
  // tmux 3.3 in the server's cwd (this process's, which started the server).
  // If a tmux release starts rejecting instead, this fails and newWindow's doc
  // comment needs revisiting.
  // [LAW:no-ambient-temporal-coupling] Before 3.7 an early listPanes reads the
  // server's cwd until the child chdirs, which on 3.3 equals the expected
  // value; a pane already running `sleep` is past the chdir, so its cwd is
  // settled. pane_current_path is the process's real cwd, not $PWD, which
  // tmux 3.3 sets to $HOME even though it never chdir'd there.
  it("CMD-05: newWindow() with a nonexistent cwd starts the pane in tmux's fallback dir (tmux falls back, does not reject)", async () => {
    sessionName = uniqueName("cmd-nw-nocwd");
    client = await attachSession(socketName, sessionName);

    const created = await newWindow(client, {
      session: sessionName,
      cwd: join(tmpdir(), "nw-does-not-exist", uniqueName("x")),
      command: "sleep 60",
    });

    const pane = await waitForPane(
      client,
      (p) => p.paneId === created.paneId && p.currentCommand === "sleep",
    );
    const fallback = realpathSync(
      RUNNING_TMUX_VERSION !== null &&
        missingCwdFallback(RUNNING_TMUX_VERSION) === "server-cwd"
        ? process.cwd()
        : homedir(),
    );
    expect(pane.cwd).toBe(fallback);
  }, 15000);

  it("CMD-05: newWindow() environment reaches the window's process as written and stays out of the session's environment", async () => {
    sessionName = uniqueName("cmd-nw-env");
    client = await attachSession(socketName, sessionName);
    const literal = "#{session_name} $HOME 'q' a=b";

    const created = await newWindow(client, {
      session: sessionName,
      command: `printf '[%s][%s]\\n' "$NW_PLAIN" "$NW_LITERAL"; sleep 60`,
      environment: { NW_PLAIN: "plain", NW_LITERAL: literal },
    });

    await waitForPaneText(client, created.paneId, `[plain][${literal}]`);
    const sessionEnvironment = await client.execute(
      `show-environment -t ${tmuxEscape(sessionName)}`,
    );
    expect(sessionEnvironment.output.join("\n")).not.toMatch(/NW_/);
  }, 15000);

  it("CMD-05: newWindow() leaves the session's current window alone unless select is true", async () => {
    sessionName = uniqueName("cmd-nw-sel");
    client = await attachSession(socketName, sessionName);
    const target = uniqueName("cmd-nw-sel-target");
    await client.execute(`new-session -d -s ${tmuxEscape(target)}`);
    const currentWindow = () =>
      displayFormat(client!, `=${target}:`, "#{window_id}");
    const initial = await currentWindow();

    await newWindow(client, { session: target, command: "sleep 60" });
    expect(await currentWindow()).toBe(initial);

    const selected = await newWindow(client, {
      session: target,
      command: "sleep 60",
      select: true,
    });
    expect(await currentWindow()).toBe(`@${selected.windowId}`);
  }, 15000);

  // The control client's own session starts in this process's cwd, so a pane
  // that lands in `start` took the target session's directory, not the
  // client's.
  it("CMD-05: newWindow() without cwd starts the pane in the target session's directory", async () => {
    sessionName = uniqueName("cmd-nw-defcwd");
    client = await attachSession(socketName, sessionName);
    const target = uniqueName("cmd-nw-defcwd-target");
    const start = realpathSync(mkdtempSync(join(tmpdir(), "nw-start-")));

    try {
      await client.execute(
        `new-session -d -s ${tmuxEscape(target)} -c ${tmuxEscape(start)}`,
      );
      const created = await newWindow(client, {
        session: target,
        command: "sleep 60",
      });

      await waitForPane(
        client,
        (p) => p.paneId === created.paneId && p.cwd === start,
      );
    } finally {
      rmSync(start, { recursive: true, force: true });
    }
  }, 15000);

  it("CMD-05: respawnPane() runs a command with its environment and cwd in a dead pane tmux kept", async () => {
    sessionName = uniqueName("cmd-rp");
    client = await attachSession(socketName, sessionName);
    // '#S' in the name: tmux format-expands respawn-pane's -c as well.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "rp-#S-")));
    const release = join(cwd, "go");

    try {
      const created = await newWindow(client, {
        session: sessionName,
        command: `while [ ! -e '${release}' ]; do sleep 0.1; done; exit 3`,
      });
      await client.execute(
        `set-option -p -t %${created.paneId} remain-on-exit on`,
      );
      writeFileSync(release, "");
      expect(await waitForDeadPane(client, created.paneId)).toBe("3");

      await respawnPane(client, created.paneId, {
        command: `printf '[%s][%s]\\n' "$RP_VAR" "$(pwd -P)"; sleep 60`,
        environment: { RP_VAR: "again" },
        cwd,
      });

      await waitForPaneText(client, created.paneId, `[again][${cwd}]`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  // The '-k' case pins the '--' before the command on the running tmux:
  // without it tmux reads '-k' as respawn-pane's kill flag, replies success,
  // and the pane's process is gone.
  it("CMD-05: respawnPane() rejects on a pane whose process is alive, whatever the command, and leaves the process running", async () => {
    sessionName = uniqueName("cmd-rp-live");
    client = await attachSession(socketName, sessionName);
    const live = await newWindow(client, {
      session: sessionName,
      command: "sleep 60",
    });
    const pid = (await waitForPane(client, (p) => p.paneId === live.paneId))
      .pid;

    for (const command of ["true", "-k"]) {
      const attempt = respawnPane(client, live.paneId, { command });
      await expect(attempt).rejects.toBeInstanceOf(TmuxCommandError);
      await expect(attempt).rejects.toThrow(/still active/);
    }
    const after = await waitForPane(client, (p) => p.paneId === live.paneId);
    expect(after.pid).toBe(pid);
    expect(pid).toBeGreaterThan(0);
  }, 15000);

  it.skipIf(!tmuxAtLeast(EMPTY_WINDOW_MIN_VERSION))(
    "CMD-05: newEmptyWindow() then remain-on-exit failed then respawnPane() keeps the pane of a command that cannot run, with its output",
    async () => {
      sessionName = uniqueName("cmd-ew-fail");
      client = await attachSession(socketName, sessionName);
      const missing = uniqueName("no-such-command");

      const { paneId } = await newEmptyWindow(client, {
        session: sessionName,
      });
      await client.execute(`set-option -p -t %${paneId} remain-on-exit failed`);
      await respawnPane(client, paneId, { command: missing });

      expect(await waitForDeadPane(client, paneId)).toBe("127");
      await waitForPaneText(client, paneId, missing);
    },
    15000,
  );

  it.skipIf(!tmuxAtLeast(EMPTY_WINDOW_MIN_VERSION))(
    "CMD-05: newEmptyWindow() with select is the session's current window, and respawnPane() starts its process with the given environment and cwd",
    async () => {
      sessionName = uniqueName("cmd-ew");
      client = await attachSession(socketName, sessionName);
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ew-")));

      try {
        const { windowId, paneId } = await newEmptyWindow(client, {
          session: sessionName,
          select: true,
        });
        expect(
          await displayFormat(client, `=${sessionName}:`, "#{window_id}"),
        ).toBe(`@${windowId}`);

        await respawnPane(client, paneId, {
          command: `printf '[%s][%s]\\n' "$EW_VAR" "$(pwd -P)"; sleep 60`,
          environment: { EW_VAR: "started" },
          cwd,
        });

        await waitForPaneText(client, paneId, `[started][${cwd}]`);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    15000,
  );

  it.skipIf(
    RUNNING_TMUX_VERSION === null || tmuxAtLeast(EMPTY_WINDOW_MIN_VERSION),
  )(
    "CMD-05: newEmptyWindow() rejects below tmux 3.8 with UnsupportedTmuxVersionError and creates no window",
    async () => {
      sessionName = uniqueName("cmd-ew-old");
      client = await attachSession(socketName, sessionName);
      const windowsBefore = (await listWindows(client)).length;

      await expect(
        newEmptyWindow(client, { session: sessionName }),
      ).rejects.toBeInstanceOf(UnsupportedTmuxVersionError);
      expect(await listWindows(client)).toHaveLength(windowsBefore);
    },
    15000,
  );

  // No waitForPane here: on 3.7 any path paneCwd reads is the settled one, so
  // the only retry allowed is on PaneCwdUnavailableError (no path yet), never
  // on a path that differs from the expected one.
  async function settledPaneCwd(c: TmuxClient, paneId: number) {
    for (;;) {
      try {
        return await paneCwd(c, paneId);
      } catch (err) {
        if (!(err instanceof PaneCwdUnavailableError)) throw err;
      }
    }
  }
  it.skipIf(!tmuxAtLeast(PANE_CWD_MIN_VERSION))(
    "CMD-06: paneCwd() straight after newWindow() reads the requested cwd, or the $HOME fallback for a missing one",
    async () => {
      sessionName = uniqueName("cmd-pcwd");
      client = await attachSession(socketName, sessionName);
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pcwd-")));

      try {
        const made = await newWindow(client, {
          session: sessionName,
          cwd,
          command: "sleep 60",
        });
        const missing = await newWindow(client, {
          session: sessionName,
          cwd: join(cwd, "does-not-exist"),
          command: "sleep 60",
        });

        expect(await settledPaneCwd(client, made.paneId)).toBe(cwd);
        expect(await settledPaneCwd(client, missing.paneId)).toBe(
          realpathSync(homedir()),
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    15000,
  );

  it.skipIf(RUNNING_TMUX_VERSION === null || tmuxAtLeast(PANE_CWD_MIN_VERSION))(
    "CMD-06: paneCwd() rejects below tmux 3.7 with UnsupportedTmuxVersionError",
    async () => {
      sessionName = uniqueName("cmd-pcwd-old");
      client = await attachSession(socketName, sessionName);
      const [pane] = await listPanes(client);

      await expect(paneCwd(client, pane.paneId)).rejects.toBeInstanceOf(
        UnsupportedTmuxVersionError,
      );
    },
    15000,
  );
});
