// tests/unit/commands-capture-pane.test.ts
// Unit coverage for capturePane's own pure logic — join, line count, and the
// latin1-container byte boundary — against a fake TmuxConnection. The
// tmux-side wire behavior (does `-J` really avoid the trailing-artifact line
// seed-builder.ts has to strip for the no-`-J` capture, does `-t %<id>`
// actually address the right pane) is adapter behavior, verified separately
// against a real tmux in tests/integration/client.test.ts's CMD-04.

import { describe, it, expect } from "vitest";
import type { TmuxConnection } from "../../src/client.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import { capturePane } from "../../src/commands/index.js";

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

describe("capturePane", () => {
  it("rejoins response.output with \\n and sets lineCount to the line count", async () => {
    const { client } = fakeConnection(["line one", "line two", "line three"]);
    const capture = await capturePane(client, 3);

    expect(new TextDecoder().decode(capture.bytes)).toBe(
      "line one\nline two\nline three",
    );
    expect(capture.lineCount).toBe(3);
  });

  it("issues capture-pane -p -e -J -S - targeted at the given pane", async () => {
    const { client, lastCommand } = fakeConnection([""]);
    await capturePane(client, 7);

    expect(lastCommand()).toBe("capture-pane -p -e -J -S - -t '%7'");
  });

  it("is byte-faithful: every latin1 code unit round-trips through bytes unchanged", async () => {
    // One line carrying every byte value 0x00-0xFF as a latin1-container
    // code unit, exactly the shape `CommandResponse.output` lines take.
    let line = "";
    for (let b = 0; b <= 0xff; b++) line += String.fromCharCode(b);
    const { client } = fakeConnection([line]);

    const capture = await capturePane(client, 1);

    expect(capture.bytes.length).toBe(256);
    for (let b = 0; b <= 0xff; b++) {
      expect(capture.bytes[b]).toBe(b);
    }
    expect(capture.lineCount).toBe(1);
  });

  // [LAW:comments-carry-meaning] Documents the one case where lineCount is
  // NOT recoverable by decoding bytes and splitting on "\n": "".split("\n")
  // has length 1, but zero captured lines is lineCount 0. lineCount is the
  // authoritative count (response.output.length); bytes is a derived join
  // of it, not an independent source — see PaneCapture's doc comment.
  it("lineCount is 0 for an empty capture, though the joined bytes decode to one empty line", async () => {
    const { client } = fakeConnection([]);
    const capture = await capturePane(client, 1);

    expect(capture.bytes.length).toBe(0);
    expect(capture.lineCount).toBe(0);
    expect(new TextDecoder().decode(capture.bytes).split("\n").length).toBe(1);
  });
});
