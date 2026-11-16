// tests/helpers/topology-moves.ts
// The pane- and window-move cases every connection that routes scoped pane
// output must follow, registered against whatever connection an opener
// returns. tests/integration/pane-scope.test.ts runs them on TmuxClient and
// examples/web-multiplexer/web/pane-stream-bridge.test.ts runs them through
// the demo's browser path, so the demo cannot drift from the moves the library
// follows.
//
// A tmux control client receives %output only for panes in its attached
// session's windows, so every case provokes output from a pane in a window of
// the attached session.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { killTmuxServer } from "./reap-test-sockets.js";
import { uniqueSocket, uniqueName, pollUntil, tmux } from "./integration.js";
import type { TmuxConnection } from "../../src/client.js";
import {
  sessionScope,
  windowScope,
  PANE_LIST_FORMAT,
  parseListReply,
  parsePaneListLine,
} from "../../src/pane-output.js";
import type { BytesSink } from "../../src/pane-output.js";

/** The part of a connection the move cases drive. */
export type MovesConnection = Pick<
  TmuxConnection,
  "execute" | "attachBytesSink"
>;

/** Creates `session` on the `-L socketName` server and attaches a connection
 *  to it. */
export type OpenConnection = (
  socketName: string,
  session: string,
) => Promise<{ readonly conn: MovesConnection; close(): void }>;

export interface ArrivedChunk {
  readonly paneId: number;
  readonly data: Uint8Array;
}

/** `{paneId, windowId, sessionId}` for every pane on the server. */
export async function listAllPanes(
  conn: Pick<TmuxConnection, "execute">,
): Promise<{ paneId: number; windowId: number; sessionId: number }[]> {
  const command = `list-panes -a -F '${PANE_LIST_FORMAT}'`;
  const response = await conn.execute(command);
  return parseListReply(command, response.output, parsePaneListLine);
}

/** Make the pane print `scope-test-<paneId>`, typed into that pane by id. */
export function sendOutputToPane(
  conn: Pick<TmuxConnection, "execute">,
  paneId: number,
): Promise<void> {
  return conn
    .execute(`send-keys -t %${paneId} 'echo scope-test-${paneId}' Enter`)
    .then(() => undefined);
}

const decoder = new TextDecoder();
export function textOf(arrived: ArrivedChunk[], paneId: number): string {
  return arrived
    .filter((e) => e.paneId === paneId)
    .map((e) => decoder.decode(e.data))
    .join("");
}

/** A sink that records every chunk it is written into `arrived`. */
export function makeRecordingSink(arrived: ArrivedChunk[]): BytesSink {
  return {
    write(msg): void {
      arrived.push({ paneId: msg.paneId, data: msg.data.slice() });
    },
    end(): void {},
  };
}

async function attachedSessionId(conn: MovesConnection): Promise<number> {
  const reply = await conn.execute("display-message -p '#{session_id}'");
  return Number(reply.output[0]!.trim().slice(1));
}

export function describeTopologyMoves(
  label: string,
  open: OpenConnection,
): void {
  // Every case drives real tmux.
  describe.skipIf(process.env.TMUX_INTEGRATION !== "1")(
    `topology moves: ${label}`,
    () => {
      let socketName = "";
      let opened: { conn: MovesConnection; close(): void } | null = null;

      beforeEach(() => {
        socketName = uniqueSocket("tmux-scope-test-", "moves");
      });

      afterEach(() => {
        opened?.close();
        opened = null;
        if (socketName !== "") killTmuxServer(socketName);
        socketName = "";
      });

      async function attach(session: string): Promise<MovesConnection> {
        opened = await open(socketName, session);
        return opened.conn;
      }

      it("SCOPE-06: a pane joined into another window routes to it, not its old window", async () => {
        const session = uniqueName("join");
        const conn = await attach(session);
        // Two panes in the first window, so it survives the join and reports the
        // move as a layout-change; a second window to join into.
        await conn.execute("split-window");
        await conn.execute("new-window");

        const all = await listAllPanes(conn);
        const windowIds = [...new Set(all.map((p) => p.windowId))];
        expect(windowIds.length).toBe(2);
        const [fromWindow, toWindow] = windowIds;
        const movedPane = all.filter((p) => p.windowId === fromWindow)[1]
          .paneId;

        const inFrom: ArrivedChunk[] = [];
        const inTo: ArrivedChunk[] = [];
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
        const conn = await attach(session);
        await conn.execute("split-window");

        const all = await listAllPanes(conn);
        const [fromWindow] = [...new Set(all.map((p) => p.windowId))];
        const { paneId: movedPane, sessionId } = all[1];

        const inFrom: ArrivedChunk[] = [];
        const inSession: ArrivedChunk[] = [];
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
        const conn = await attach(session);
        const other = uniqueName("mvwin-src");
        // Two windows, so moving one out leaves the source session alive.
        tmux(socketName, ["new-session", "-d", "-s", other]);
        tmux(socketName, ["new-window", "-d", "-t", `${other}:`]);

        const all = await listAllPanes(conn);
        const attachedId = await attachedSessionId(conn);
        const moved = all.find((p) => p.sessionId !== attachedId)!;

        const inAttached: ArrivedChunk[] = [];
        const inOld: ArrivedChunk[] = [];
        const disposeAttached = conn.attachBytesSink(
          makeRecordingSink(inAttached),
          { scope: sessionScope(attachedId) },
        );
        const disposeOld = conn.attachBytesSink(makeRecordingSink(inOld), {
          scope: sessionScope(moved.sessionId),
        });
        // tmux reports this only as %window-add; the window keeps its id and
        // its panes keep their ids. tmux runs a client's commands one at a time,
        // so the stall holds the window-add refresh back while the moved pane's
        // output (provoked through the CLI, outside that queue) arrives.
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

        await pollUntil(() =>
          textOf(inAttached, moved.paneId).includes(marker),
        );
        expect(textOf(inOld, moved.paneId)).not.toContain(marker);
        disposeAttached();
        disposeOld();
      }, 20000);

      it("SCOPE-06e: a window unlinked from another session it was linked into keeps routing in the attached session", async () => {
        const session = uniqueName("unlink");
        const conn = await attach(session);
        const other = uniqueName("unlink-other");
        tmux(socketName, ["new-session", "-d", "-s", other]);

        const all = await listAllPanes(conn);
        const attachedId = await attachedSessionId(conn);
        const { paneId, windowId } = all.find(
          (p) => p.sessionId === attachedId,
        )!;
        // The window lives in both sessions until it is unlinked from `other`.
        tmux(socketName, [
          "link-window",
          "-d",
          "-s",
          `@${windowId}`,
          "-t",
          `${other}:`,
        ]);

        const inWindow: ArrivedChunk[] = [];
        const inAttached: ArrivedChunk[] = [];
        const disposeWindow = conn.attachBytesSink(
          makeRecordingSink(inWindow),
          {
            scope: windowScope(windowId),
          },
        );
        const disposeAttached = conn.attachBytesSink(
          makeRecordingSink(inAttached),
          { scope: sessionScope(attachedId) },
        );
        tmux(socketName, ["unlink-window", "-t", `${other}:@${windowId}`]);
        // Replies in order: the unlink's notifications have arrived and their
        // queries have settled before the output is provoked.
        await conn.execute("display-message -p settled");
        await sendOutputToPane(conn, paneId);

        const marker = `scope-test-${paneId}`;
        await pollUntil(
          () =>
            textOf(inWindow, paneId).includes(marker) &&
            textOf(inAttached, paneId).includes(marker),
        );
        disposeWindow();
        disposeAttached();
      }, 20000);
    },
  );
}
