// tests/helpers/topology-moves.ts
// The pane- and window-move routing cases, registered against any connection
// that routes pane output by scope, plus the pane-output helpers they share
// with the rest of the scope suite.
//
// [LAW:one-source-of-truth] One copy of each move case. The library's client
//   runs them in tests/integration/pane-scope.test.ts; the web-multiplexer
//   demo's bridge runs the same cases in
//   examples/web-multiplexer/web/pane-stream-bridge.test.ts, so the demo
//   cannot drift from the moves the library follows.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { killTmuxServer } from "./reap-test-sockets.js";
import { uniqueSocket, uniqueName, pollUntil, tmux } from "./integration.js";
import type { TmuxConnection } from "../../src/client.js";
import {
  sessionScope,
  windowScope,
  PANE_LIST_FORMAT,
  parsePaneListLine,
} from "../../src/pane-output.js";
import type { BytesSink } from "../../src/pane-output.js";

/** What the scope cases drive: commands, and scoped byte sinks. */
export type ScopedConnection = Pick<
  TmuxConnection,
  "execute" | "attachBytesSink"
>;

/** A connection attached to `session` on the tmux server `socketName`. */
export interface OpenedConnection {
  readonly conn: ScopedConnection;
  close(): void;
}

export type OpenConnection = (
  socketName: string,
  session: string,
) => Promise<OpenedConnection>;

/** Every pane on the server as `{paneId, windowId, sessionId}`. */
export async function listAllPanes(
  conn: ScopedConnection,
): Promise<{ paneId: number; windowId: number; sessionId: number }[]> {
  const response = await conn.execute(`list-panes -a -F '${PANE_LIST_FORMAT}'`);
  return response.output.flatMap((line) => {
    const parsed = parsePaneListLine(line);
    return parsed !== null ? [parsed] : [];
  });
}

/**
 * Send a keystroke to the given pane so it produces output.
 *
 * Uses `send-keys … Enter` to a specific pane target so the pane that
 * receives input is explicit, not the currently-active pane.
 */
export function sendOutputToPane(
  conn: ScopedConnection,
  paneId: number,
): Promise<void> {
  return conn
    .execute(`send-keys -t %${paneId} 'echo scope-test-${paneId}' Enter`)
    .then(() => undefined);
}

const decoder = new TextDecoder();
export function textOf(
  arrived: { paneId: number; data: Uint8Array }[],
  paneId: number,
): string {
  return arrived
    .filter((e) => e.paneId === paneId)
    .map((e) => decoder.decode(e.data))
    .join("");
}

/**
 * Return a `BytesSink` that collects every chunk where `paneId` matches a set.
 * `arrived` is the live reference — push to it from `write`.
 */
export function makeRecordingSink(
  arrived: { paneId: number; data: Uint8Array }[],
): BytesSink {
  return {
    write(msg): void {
      arrived.push({ paneId: msg.paneId, data: msg.data.slice() });
    },
    end(): void {},
  };
}

async function sessionIdOf(conn: ScopedConnection): Promise<number> {
  const r = await conn.execute("display-message -p '#{session_id}'");
  return Number(r.output[0]!.trim().slice(1));
}

/**
 * Register the move cases under `label`, each on a fresh isolated tmux server
 * with a connection `open` attaches to the case's session.
 */
export function describeTopologyMoves(
  label: string,
  open: OpenConnection,
): void {
  describe(label, () => {
    let socketName = "";
    let opened: OpenedConnection | null = null;

    beforeEach(() => {
      socketName = uniqueSocket("tmux-scope-test-", "moves");
    });

    afterEach(() => {
      opened?.close();
      opened = null;
      if (socketName !== "") killTmuxServer(socketName);
      socketName = "";
    });

    async function attach(session: string): Promise<ScopedConnection> {
      opened = await open(socketName, session);
      return opened.conn;
    }

    it("SCOPE-06: a pane joined into another window routes to it, not its old window", async () => {
      const session = uniqueName("join");
      tmux(socketName, ["new-session", "-d", "-s", session]);
      const conn = await attach(session);
      // Two panes in the first window, so it survives the join and reports
      // the move as a layout-change; a second window to join into.
      await conn.execute("split-window");
      await conn.execute("new-window");

      const all = await listAllPanes(conn);
      const windowIds = [...new Set(all.map((p) => p.windowId))];
      expect(windowIds.length).toBe(2);
      const [fromWindow, toWindow] = windowIds;
      const movedPane = all.filter((p) => p.windowId === fromWindow)[1].paneId;

      const inFrom: { paneId: number; data: Uint8Array }[] = [];
      const inTo: { paneId: number; data: Uint8Array }[] = [];
      const disposeFrom = conn.attachBytesSink(makeRecordingSink(inFrom), {
        scope: windowScope(fromWindow),
      });
      const disposeTo = conn.attachBytesSink(makeRecordingSink(inTo), {
        scope: windowScope(toWindow),
      });
      tmux(socketName, [
        "join-pane",
        "-s",
        `%${movedPane}`,
        "-t",
        `@${toWindow}`,
      ]);
      await sendOutputToPane(conn, movedPane);

      const marker = `scope-test-${movedPane}`;
      await pollUntil(() => textOf(inTo, movedPane).includes(marker));
      expect(textOf(inFrom, movedPane)).not.toContain(marker);
      disposeFrom();
      disposeTo();
    }, 20000);

    it("SCOPE-06c: a pane broken out into a new window stops routing to its old window", async () => {
      const session = uniqueName("break");
      tmux(socketName, ["new-session", "-d", "-s", session]);
      const conn = await attach(session);
      await conn.execute("split-window");

      const all = await listAllPanes(conn);
      const [fromWindow] = [...new Set(all.map((p) => p.windowId))];
      const { paneId: movedPane, sessionId } = all[1];

      const inFrom: { paneId: number; data: Uint8Array }[] = [];
      const inSession: { paneId: number; data: Uint8Array }[] = [];
      const disposeFrom = conn.attachBytesSink(makeRecordingSink(inFrom), {
        scope: windowScope(fromWindow),
      });
      const disposeSession = conn.attachBytesSink(
        makeRecordingSink(inSession),
        { scope: sessionScope(sessionId) },
      );
      // tmux reports break-pane only as the old window's layout omitting the
      // pane, then %window-add for the new one.
      tmux(socketName, ["break-pane", "-d", "-s", `%${movedPane}`]);
      await sendOutputToPane(conn, movedPane);

      const marker = `scope-test-${movedPane}`;
      await pollUntil(() => textOf(inSession, movedPane).includes(marker));
      expect(textOf(inFrom, movedPane)).not.toContain(marker);
      disposeFrom();
      disposeSession();
    }, 20000);

    it("SCOPE-06d: a window moved in from another session routes to the attached session, not its old one", async () => {
      const session = uniqueName("mvwin");
      tmux(socketName, ["new-session", "-d", "-s", session]);
      const conn = await attach(session);
      const other = uniqueName("mvwin-src");
      // Two windows, so moving one out leaves the source session alive.
      tmux(socketName, ["new-session", "-d", "-s", other]);
      tmux(socketName, ["new-window", "-d", "-t", `${other}:`]);

      const all = await listAllPanes(conn);
      const attachedId = await sessionIdOf(conn);
      const moved = all.find((p) => p.sessionId !== attachedId)!;

      const inAttached: { paneId: number; data: Uint8Array }[] = [];
      const inOld: { paneId: number; data: Uint8Array }[] = [];
      const disposeAttached = conn.attachBytesSink(
        makeRecordingSink(inAttached),
        { scope: sessionScope(attachedId) },
      );
      const disposeOld = conn.attachBytesSink(makeRecordingSink(inOld), {
        scope: sessionScope(moved.sessionId),
      });
      // tmux reports this only as %window-add; the window keeps its id and
      // its panes keep their ids. tmux runs a client's commands one at a
      // time, so the stall holds the window-add refresh back while the moved
      // pane's output (provoked through the CLI, outside that queue) arrives.
      // The attach-triggered bootstraps reply before anything after them.
      await conn.execute("display-message -p settled");
      const stall = conn.execute("run-shell 'sleep 0.5'");
      tmux(socketName, [
        "move-window",
        "-d",
        "-s",
        `@${moved.windowId}`,
        "-t",
        `${session}:`,
      ]);
      const marker = `scope-test-${moved.paneId}`;
      tmux(socketName, [
        "send-keys",
        "-t",
        `%${moved.paneId}`,
        `echo ${marker}`,
        "Enter",
      ]);
      await stall;

      await pollUntil(() => textOf(inAttached, moved.paneId).includes(marker));
      expect(textOf(inOld, moved.paneId)).not.toContain(marker);
      disposeAttached();
      disposeOld();
    }, 20000);

    it("SCOPE-06e: a window unlinked from another session keeps routing in the attached session", async () => {
      const session = uniqueName("unlink");
      tmux(socketName, ["new-session", "-d", "-s", session]);
      const conn = await attach(session);
      const other = uniqueName("unlink-other");
      // Two windows, so unlinking one leaves the other session alive.
      tmux(socketName, ["new-session", "-d", "-s", other]);
      tmux(socketName, ["new-window", "-d", "-t", `${other}:9`]);

      const attachedId = await sessionIdOf(conn);
      const shared = (await listAllPanes(conn)).find(
        (p) => p.sessionId !== attachedId,
      )!;
      tmux(socketName, [
        "link-window",
        "-d",
        "-s",
        `@${shared.windowId}`,
        "-t",
        `${session}:`,
      ]);

      const inWindow: { paneId: number; data: Uint8Array }[] = [];
      const inAttached: { paneId: number; data: Uint8Array }[] = [];
      const disposeWindow = conn.attachBytesSink(makeRecordingSink(inWindow), {
        scope: windowScope(shared.windowId),
      });
      const disposeAttached = conn.attachBytesSink(
        makeRecordingSink(inAttached),
        { scope: sessionScope(attachedId) },
      );
      await conn.execute("display-message -p settled");
      // tmux reports the unlink to this client as %window-close although the
      // window stays linked in the attached session.
      tmux(socketName, ["unlink-window", "-t", `${other}:@${shared.windowId}`]);
      await sendOutputToPane(conn, shared.paneId);

      const marker = `scope-test-${shared.paneId}`;
      await pollUntil(() => textOf(inWindow, shared.paneId).includes(marker));
      await pollUntil(() => textOf(inAttached, shared.paneId).includes(marker));
      disposeWindow();
      disposeAttached();
    }, 20000);
  });
}
