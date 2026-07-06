// tests/integration/client.test.ts
// Integration tests for TmuxClient against a real tmux process.
//
// [LAW:verifiable-goals] Tests are gated behind TMUX_INTEGRATION=1 so CI does
// not fail when tmux is unavailable, but can be run explicitly to verify
// real-world behaviour against an actual tmux binary.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import {
  listWindows,
  listPanes,
  sendKeys,
  setSize,
  setPaneAction,
  subscribeRaw,
  unsubscribe,
  setFlags,
  clearFlags,
  queryClipboard,
  requestReport,
} from "../../src/commands/index.js";
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
// tmux server. Teardown runs `tmux -L <socket> kill-server` so the isolated
// server exits whether or not sessions linger.
//
// [LAW:single-enforcer] `tmuxCmd()` is the only place that builds the
// `tmux -L <socket> ...` command line in this file.

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
  try {
    execSync(tmuxCmd(socketName, "kill-server"), { stdio: "ignore" });
  } catch {
    // Server may already be gone — not an error.
  }
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
function createSession(
  socketName: string,
  sessionName: string,
): Promise<TmuxClient> {
  execSync(tmuxCmd(socketName, `new-session -d -s ${sessionName}`), {
    stdio: "ignore",
  });
  const transport = spawnTmux(["attach-session", "-t", sessionName], {
    socketPath: socketName,
  });
  const client = new TmuxClient(transport);

  return new Promise<TmuxClient>((resolve) => {
    const handler = (ev: ConnectionStateMessage) => {
      if (ev.state.status !== "ready") return;
      client.off("connection-state", handler);
      resolve(client);
    };
    client.on("connection-state", handler);
  });
}

// ---------------------------------------------------------------------------
// 1. Command Correlation
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("Command Correlation", () => {
  let sessionName: string;
  // Sentinel + per-test reset: socketName is "" between tests so a beforeEach
  // that throws BEFORE assignment never makes afterEach run
  // `tmux -L <stale-or-undefined> kill-server` against an unrelated tmux
  // server (worst case: the user's real server, one literally named
  // `undefined`). The reset in afterEach below restores the invariant per
  // test — without it, a successful test would leave the previous socket
  // name visible to the next test's afterEach.
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
// 3. Notification coverage (Phase 4 — every notification in SPEC §23 that we
// can trigger end-to-end without flaky timing assumptions)
// ---------------------------------------------------------------------------

/**
 * Wait for the next message of the given type from a client. Returns the
 * full event object. Times out via vitest's per-test timeout.
 */
function nextMessage<K extends keyof import("../../src/emitter.js").TmuxEventMap>(
  client: TmuxClient,
  type: K,
): Promise<import("../../src/emitter.js").TmuxEventMap[K]> {
  return new Promise((resolve) => {
    const handler = (ev: import("../../src/emitter.js").TmuxEventMap[K]) => {
      client.off(type, handler);
      resolve(ev);
    };
    client.on(type, handler);
  });
}

describe.skipIf(!RUN_INTEGRATION)("Notification coverage (SPEC §23)", () => {
  let sessionName: string;
  let socketName = "";
  let client: TmuxClient | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("notif");
  });

  afterEach(() => {
    client?.close();
    client = null;
    if (socketName !== "") killServer(socketName);
    socketName = "";
  });

  it(
    "INT-01: receives %output bytes from a real pane",
    async () => {
      sessionName = uniqueSession("int-output");
      const c = await createSession(socketName, sessionName);
      client = c;
      // Pane bytes flow through `attachBytesSink` (server scope = all panes)
      // — the emitter no longer carries `OutputMessage` so this is the only
      // way to observe bytes without knowing a paneId up front.
      const outputPromise = new Promise<{
        paneId: number;
        byteLength: number;
      }>((resolve) => {
        const detach = c.attachBytesSink({
          write(msg) {
            detach();
            resolve({ paneId: msg.paneId, byteLength: msg.data.byteLength });
          },
          end() {},
        });
      });
      // No target = active pane in active window of attached session.
      await c.execute("send-keys 'echo hello-output' Enter");
      const out = await outputPromise;
      expect(typeof out.paneId).toBe("number");
      expect(out.byteLength).toBeGreaterThan(0);
    },
    15000,
  );

  it(
    "INT-02a: %window-add fires when a new window is created",
    async () => {
      sessionName = uniqueSession("int-winadd");
      const c = await createSession(socketName, sessionName);
      client = c;
      const evt = nextMessage(c, "window-add");
      await c.execute("new-window");
      const ev = await evt;
      expect(typeof ev.windowId).toBe("number");
    },
    15000,
  );

  it(
    "INT-02b: %window-renamed fires when a window is renamed",
    async () => {
      sessionName = uniqueSession("int-winren");
      const c = await createSession(socketName, sessionName);
      client = c;
      const evt = nextMessage(c, "window-renamed");
      await c.execute("rename-window renamed-target");
      const ev = await evt;
      expect(ev.name).toBe("renamed-target");
    },
    15000,
  );

  it(
    "INT-02c: %unlinked-window-close fires when a window is closed",
    async () => {
      sessionName = uniqueSession("int-winclose");
      const c = await createSession(socketName, sessionName);
      client = c;
      // Create a uniquely-named window we can target by name.
      await c.execute("new-window -d -n closeme");
      // Per SPEC §6.2: tmux's kill-window unlinks the window from the
      // session BEFORE the close notification fires, so the receiving
      // client (us) sees %unlinked-window-close, not %window-close.
      // Both are valid spec-compliant variants of "window-close".
      const evt = nextMessage(c, "unlinked-window-close");
      await c.execute("kill-window -t closeme");
      const ev = await evt;
      expect(typeof ev.windowId).toBe("number");
    },
    15000,
  );

  it(
    "INT-02d: %window-pane-changed fires when the active pane changes",
    async () => {
      sessionName = uniqueSession("int-paneact");
      const c = await createSession(socketName, sessionName);
      client = c;
      await c.execute("split-window -h");
      const evt = nextMessage(c, "window-pane-changed");
      await c.execute("select-pane -t :.+");
      const ev = await evt;
      expect(typeof ev.windowId).toBe("number");
      expect(typeof ev.paneId).toBe("number");
    },
    15000,
  );

  it(
    "INT-03a: %sessions-changed fires when a new session is created",
    async () => {
      sessionName = uniqueSession("int-sescre");
      const c = await createSession(socketName, sessionName);
      client = c;
      const evt = nextMessage(c, "sessions-changed");
      const otherName = uniqueSession("int-other");
      // Same isolated server — must use the same -L socket so the attached
      // control-mode client actually sees %sessions-changed.
      execSync(tmuxCmd(socketName, `new-session -d -s ${otherName}`), {
        stdio: "ignore",
      });
      await evt;
      execSync(tmuxCmd(socketName, `kill-session -t ${otherName}`), {
        stdio: "ignore",
      });
    },
    15000,
  );

  it(
    "INT-04: %layout-change fires after split-window",
    async () => {
      sessionName = uniqueSession("int-layout");
      const c = await createSession(socketName, sessionName);
      client = c;
      const evt = nextMessage(c, "layout-change");
      await c.execute("split-window -h");
      const ev = await evt;
      expect(typeof ev.windowId).toBe("number");
      expect(typeof ev.windowLayout).toBe("string");
      expect(ev.windowLayout.length).toBeGreaterThan(0);
    },
    15000,
  );

  it(
    "INT-05: %exit fires on detach",
    async () => {
      sessionName = uniqueSession("int-exit");
      const c = await createSession(socketName, sessionName);
      client = c;
      const evt = nextMessage(c, "exit");
      c.detach();
      await evt;
      client = null;
    },
    15000,
  );
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
    "CMD-01: listWindows() returns a successful response with at least one output line",
    async () => {
      sessionName = uniqueSession("cmd-lw");
      client = await createSession(socketName, sessionName);

      // [LAW:types-are-the-program] Type the client as TmuxConnection — the
      // free function takes the minimal interface, not the full TmuxClient.
      const r = await listWindows(client);

      expect(r.success).toBe(true);
      expect(typeof r.commandNumber).toBe("number");
      expect(Array.isArray(r.output)).toBe(true);
      // list-windows always has at least one line (the initial window).
      expect(r.output.length).toBeGreaterThan(0);
    },
    15000,
  );

  it(
    "CMD-02: listPanes() returns a successful response with at least one output line",
    async () => {
      sessionName = uniqueSession("cmd-lp");
      client = await createSession(socketName, sessionName);

      const r = await listPanes(client);

      expect(r.success).toBe(true);
      expect(Array.isArray(r.output)).toBe(true);
      expect(r.output.length).toBeGreaterThan(0);
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
});
