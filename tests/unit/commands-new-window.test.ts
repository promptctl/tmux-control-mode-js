// tests/unit/commands-new-window.test.ts
// Unit coverage for the commands that start a pane's process (newWindow,
// newEmptyWindow, respawnPane): the command each sends, what each refuses
// before sending, and how the reply is read, against a fake TmuxConnection.
// What tmux does with those commands is verified against real tmux in
// tests/integration/client.test.ts's CMD-05; newEmptyWindow's version gate is
// in command-version-gates.test.ts.

import { describe, it, expect } from "vitest";
import type { TmuxConnection } from "../../src/client.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import {
  newWindow,
  newEmptyWindow,
  respawnPane,
} from "../../src/commands/index.js";
import type { PaneProcess } from "../../src/commands/index.js";
import { TmuxReplyFormatError } from "../../src/errors.js";

// Records every command sent, so "nothing was sent" is the empty list.
function fakeConnection(output: readonly string[]): {
  client: TmuxConnection;
  sent: string[];
} {
  const sent: string[] = [];
  const client: Pick<TmuxConnection, "execute"> = {
    execute: (command: string): Promise<CommandResponse> => {
      sent.push(command);
      return Promise.resolve({
        commandNumber: sent.length,
        timestamp: Date.now(),
        output,
        success: true,
      });
    },
  };
  return { client: client as TmuxConnection, sent };
}

const NEW_WINDOW = "new-window -d -t '=work:' -P -F '#{window_id}\t#{pane_id}'";

// A process tmux would honor somewhere else than the caller asked.
const REFUSED_PROCESSES: readonly PaneProcess[] = [
  { cwd: "" },
  { cwd: "proj" },
  { cwd: "~/proj" },
  { cwd: "/tmp/a\nb" },
  { command: "" },
  { command: "a\nb" },
  { environment: { "": "v" } },
  { environment: { "A=B": "v" } },
  { environment: { "A\nB": "v" } },
  { environment: { A: "a\nb" } },
];

describe("newWindow", () => {
  it("issues a detached new-window in the session with reply format, cwd, and command", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, {
      session: "work",
      cwd: "/home/me/it's here",
      command: "vim notes.md",
    });

    expect(sent).toEqual([
      `${NEW_WINDOW} -c '/home/me/it'\\''s here' -- 'vim notes.md'`,
    ]);
  });

  it("doubles '#' in cwd so tmux's format expansion leaves it literal, but not in command", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, {
      session: "work",
      cwd: "/tmp/a#Sb",
      command: "echo #S",
    });

    expect(sent).toEqual([`${NEW_WINDOW} -c '/tmp/a##Sb' -- 'echo #S'`]);
  });

  it("passes each environment entry as its own -e, in order, quoted but otherwise as written", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, {
      session: "work",
      environment: { QUOTE: "it's", FORMAT: "#{session_name}", EQ: "a=b" },
    });

    expect(sent).toEqual([
      `${NEW_WINDOW} -e 'QUOTE=it'\\''s' -e 'FORMAT=#{session_name}' -e 'EQ=a=b'`,
    ]);
  });

  it("drops -d for select: true, so the window becomes the session's current one", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, { session: "work", select: true });

    expect(sent).toEqual([
      "new-window -t '=work:' -P -F '#{window_id}\t#{pane_id}'",
    ]);
  });

  it("omits -c and the command when neither is given, leaving both to tmux", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, { session: "work" });

    expect(sent).toEqual([NEW_WINDOW]);
  });

  it("puts a command starting with '-' after '--', so tmux does not read it as flags", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, { session: "work", command: "-t=other:" });

    expect(sent).toEqual([`${NEW_WINDOW} -- '-t=other:'`]);
  });

  it.each(REFUSED_PROCESSES)(
    "rejects a process tmux would honor somewhere else, without sending: %j",
    async (process) => {
      const { client, sent } = fakeConnection(["@3\t%7"]);
      await expect(
        newWindow(client, { session: "work", ...process }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(sent).toEqual([]);
    },
  );

  it("parses the reply into numeric window and pane ids", async () => {
    const { client } = fakeConnection(["@12\t%40"]);
    await expect(newWindow(client, { session: "work" })).resolves.toEqual({
      windowId: 12,
      paneId: 40,
    });
  });

  it.each([[[]], [["%40"]], [["@12\t%40", "@13\t%41"]], [["@x\t%40"]]])(
    "rejects with TmuxReplyFormatError carrying the raw reply for %j",
    async (output) => {
      const { client } = fakeConnection(output);
      const attempt = newWindow(client, { session: "work" });
      await expect(attempt).rejects.toBeInstanceOf(TmuxReplyFormatError);
      await expect(attempt).rejects.toMatchObject({ output });
    },
  );
});

// '' would be '=:', the control client's own session; a newline would end the
// command line. newEmptyWindow renders before its version read, so nothing at
// all is sent.
describe.each([
  ["newWindow", newWindow],
  ["newEmptyWindow", newEmptyWindow],
])("%s session", (_name, open) => {
  it.each(["", "wo\nrk"])("rejects %j without sending", async (session) => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await expect(open(client, { session })).rejects.toBeInstanceOf(RangeError);
    expect(sent).toEqual([]);
  });
});

describe("respawnPane", () => {
  it("issues respawn-pane on the pane with cwd, environment, and command", async () => {
    const { client, sent } = fakeConnection([]);
    await respawnPane(client, 7, {
      command: "echo #S",
      environment: { QUOTE: "it's", FORMAT: "#{session_name}" },
      cwd: "/tmp/a#Sb",
    });

    expect(sent).toEqual([
      "respawn-pane -t '%7' -c '/tmp/a##Sb' " +
        "-e 'QUOTE=it'\\''s' -e 'FORMAT=#{session_name}' -- 'echo #S'",
    ]);
  });

  it("issues a bare respawn-pane when no process is given, leaving it to tmux", async () => {
    const { client, sent } = fakeConnection([]);
    await respawnPane(client, 7);

    expect(sent).toEqual(["respawn-pane -t '%7'"]);
  });

  it("puts a command starting with '-' after '--', so tmux does not read it as the kill flag", async () => {
    const { client, sent } = fakeConnection([]);
    await respawnPane(client, 7, { command: "-k" });

    expect(sent).toEqual(["respawn-pane -t '%7' -- '-k'"]);
  });

  it.each(REFUSED_PROCESSES)(
    "rejects a process tmux would honor somewhere else, without sending: %j",
    async (process) => {
      const { client, sent } = fakeConnection([]);
      await expect(respawnPane(client, 7, process)).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(sent).toEqual([]);
    },
  );
});
