// tests/unit/commands-new-window.test.ts
// Unit coverage for newWindow's own logic: the command it sends and how it
// reads the reply, against a fake TmuxConnection. What tmux does with that
// command is verified against real tmux in tests/integration/client.test.ts's
// CMD-05.

import { describe, it, expect } from "vitest";
import type { TmuxConnection } from "../../src/client.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import { newWindow } from "../../src/commands/index.js";
import { TmuxReplyFormatError } from "../../src/errors.js";

function fakeConnection(output: readonly string[]): {
  client: TmuxConnection;
  lastCommand: () => string;
} {
  let lastCommand = "";
  const client: Pick<TmuxConnection, "execute"> = {
    execute: (command: string): Promise<CommandResponse> => {
      lastCommand = command;
      return Promise.resolve({
        commandNumber: 1,
        timestamp: Date.now(),
        output,
        success: true,
      });
    },
  };
  return { client: client as TmuxConnection, lastCommand: () => lastCommand };
}

describe("newWindow", () => {
  it("issues a detached new-window in the session with cwd, reply format, and command", async () => {
    const { client, lastCommand } = fakeConnection(["@3\t%7"]);
    await newWindow(client, {
      session: "work",
      cwd: "/home/me/it's here",
      command: "vim notes.md",
    });

    expect(lastCommand()).toBe(
      "new-window -d -t 'work:' -c '/home/me/it'\\''s here' " +
        "-P -F '#{window_id}\t#{pane_id}' 'vim notes.md'",
    );
  });

  it("omits the command argument when none is given, so tmux runs the default shell", async () => {
    const { client, lastCommand } = fakeConnection(["@3\t%7"]);
    await newWindow(client, { session: "work", cwd: "/tmp" });

    expect(lastCommand()).toBe(
      "new-window -d -t 'work:' -c '/tmp' -P -F '#{window_id}\t#{pane_id}'",
    );
  });

  it("parses the reply into numeric window and pane ids", async () => {
    const { client } = fakeConnection(["@12\t%40"]);
    await expect(
      newWindow(client, { session: "work", cwd: "/tmp" }),
    ).resolves.toEqual({ windowId: 12, paneId: 40 });
  });

  it.each([[[]], [["%40"]], [["@12\t%40", "@13\t%41"]], [["@x\t%40"]]])(
    "rejects with TmuxReplyFormatError carrying the raw reply for %j",
    async (output) => {
      const { client } = fakeConnection(output);
      const attempt = newWindow(client, { session: "work", cwd: "/tmp" });
      await expect(attempt).rejects.toBeInstanceOf(TmuxReplyFormatError);
      await expect(attempt).rejects.toMatchObject({ output });
    },
  );
});
