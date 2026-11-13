// tests/unit/commands-new-window.test.ts
// Unit coverage for the commands that start a pane's process (newWindow,
// respawnPane): the command each sends, what each refuses before sending, and
// how newWindow reads the reply, against a fake TmuxConnection. What tmux does
// with those commands is verified against real tmux in
// tests/integration/client.test.ts's CMD-05; newEmptyWindow is in
// command-version-gates.test.ts with the other version-gated commands.

import { describe, it, expect } from "vitest";
import type { TmuxConnection } from "../../src/client.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import { newWindow, respawnPane } from "../../src/commands/index.js";
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

const NEW_WINDOW = "new-window -d -t '$4:' -P -F '#{window_id}\t#{pane_id}'";

// A process tmux would honor somewhere other than asked, and the field the
// refusal names.
const REFUSED: readonly (readonly [PaneProcess, string])[] = [
  [{ cwd: "" }, "PaneProcess.cwd"],
  [{ cwd: "proj" }, "PaneProcess.cwd"],
  [{ cwd: "~/proj" }, "PaneProcess.cwd"],
  [{ cwd: "/tmp/a\nb" }, "PaneProcess.cwd"],
  [{ command: "" }, "PaneProcess.command"],
  [{ command: "a\nb" }, "PaneProcess.command"],
  [{ environment: { "": "v" } }, "PaneProcess.environment name"],
  [{ environment: { "A=B": "v" } }, "PaneProcess.environment name"],
  [{ environment: { "A\nB": "v" } }, "PaneProcess.environment name"],
  [{ environment: { A: "a\nb" } }, "PaneProcess.environment value of A"],
];

describe("newWindow", () => {
  it("opens a background window in the session with that id, with cwd and command", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, {
      sessionId: 4,
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
      sessionId: 4,
      cwd: "/tmp/a#Sb",
      command: "echo #S",
    });

    expect(sent).toEqual([`${NEW_WINDOW} -c '/tmp/a##Sb' -- 'echo #S'`]);
  });

  it("passes each environment entry as its own -e, in order, quoted and otherwise as written", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, {
      sessionId: 4,
      environment: { QUOTE: "it's", FORMAT: "#{session_name}", EQ: "a=b" },
    });

    expect(sent).toEqual([
      `${NEW_WINDOW} -e 'QUOTE=it'\\''s' -e 'FORMAT=#{session_name}' -e 'EQ=a=b'`,
    ]);
  });

  it("drops -d for select: true, so the window becomes the session's current one", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, { sessionId: 4, select: true });

    expect(sent).toEqual([
      "new-window -t '$4:' -P -F '#{window_id}\t#{pane_id}'",
    ]);
  });

  it("omits -c and the command when neither is given, leaving both to tmux", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, { sessionId: 4 });

    expect(sent).toEqual([NEW_WINDOW]);
  });

  it("puts a command starting with '-' after '--', so tmux does not read it as flags", async () => {
    const { client, sent } = fakeConnection(["@3\t%7"]);
    await newWindow(client, { sessionId: 4, command: "-t=other:" });

    expect(sent).toEqual([`${NEW_WINDOW} -- '-t=other:'`]);
  });

  it.each(REFUSED)(
    "rejects a process tmux would honor somewhere else, without sending: %j names %s",
    async (paneProcess, field) => {
      const { client, sent } = fakeConnection(["@3\t%7"]);
      const attempt = newWindow(client, { sessionId: 4, ...paneProcess });
      await expect(attempt).rejects.toBeInstanceOf(RangeError);
      await expect(attempt).rejects.toThrow(field);
      expect(sent).toEqual([]);
    },
  );

  it("refuses a multi-line environment value by its variable's name, without quoting the value", async () => {
    const { client } = fakeConnection(["@3\t%7"]);
    const attempt = newWindow(client, {
      sessionId: 4,
      environment: { API_KEY: "s3cret\n" },
    });

    await expect(attempt).rejects.toMatchObject({
      message: "PaneProcess.environment value of API_KEY must be one line",
    });
  });

  it.each([[["@12\t%40"]], [["@12\t%40\r"]]])(
    "parses the reply %j into numeric window and pane ids",
    async (output) => {
      const { client } = fakeConnection(output);
      await expect(newWindow(client, { sessionId: 4 })).resolves.toEqual({
        windowId: 12,
        paneId: 40,
      });
    },
  );

  it.each([[[]], [["%40"]], [["@12\t%40", "@13\t%41"]], [["@x\t%40"]]])(
    "rejects with TmuxReplyFormatError carrying the raw reply for %j",
    async (output) => {
      const { client } = fakeConnection(output);
      const attempt = newWindow(client, { sessionId: 4 });
      await expect(attempt).rejects.toBeInstanceOf(TmuxReplyFormatError);
      await expect(attempt).rejects.toMatchObject({ output });
    },
  );
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

  it.each(REFUSED)(
    "rejects a process tmux would honor somewhere else, without sending: %j names %s",
    async (paneProcess, field) => {
      const { client, sent } = fakeConnection([]);
      const attempt = respawnPane(client, 7, paneProcess);
      await expect(attempt).rejects.toBeInstanceOf(RangeError);
      await expect(attempt).rejects.toThrow(field);
      expect(sent).toEqual([]);
    },
  );
});
