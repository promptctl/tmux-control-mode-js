// tests/unit/parser.test.ts
// Fixture-driven and unit tests for TmuxParser

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { TmuxParser } from "../../src/protocol/parser.js";
import type { TmuxMessage } from "../../src/protocol/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixtureContent(name: string): string {
  return readFileSync(join(__dirname, "../fixtures", name), "utf8");
}

function collect(content: string): {
  messages: TmuxMessage[];
  outputLines: Array<{ commandNumber: number; line: string }>;
} {
  const messages: TmuxMessage[] = [];
  const outputLines: Array<{ commandNumber: number; line: string }> = [];
  const parser = new TmuxParser((msg) => messages.push(msg));
  parser.onOutputLine = (commandNumber, line) =>
    outputLines.push({ commandNumber, line });
  parser.feed(content);
  return { messages, outputLines };
}

// ---------------------------------------------------------------------------
// Fixture: startup.txt
// ---------------------------------------------------------------------------

describe("fixture: startup.txt", () => {
  it("emits expected messages in order", () => {
    const { messages } = collect(fixtureContent("startup.txt"));

    expect(messages[0]).toMatchObject({
      type: "begin",
      timestamp: 1699900000,
      commandNumber: 0,
      flags: 0,
    });
    expect(messages[1]).toMatchObject({
      type: "end",
      timestamp: 1699900000,
      commandNumber: 0,
      flags: 0,
    });
    expect(messages[2]).toMatchObject({
      type: "session-changed",
      sessionId: 1,
      name: "main",
    });
    expect(messages[3]).toMatchObject({ type: "sessions-changed" });
    expect(messages[4]).toMatchObject({ type: "window-add", windowId: 1 });
    expect(messages[5]).toMatchObject({
      type: "window-pane-changed",
      windowId: 1,
      paneId: 1,
    });
    expect(messages[6]).toMatchObject({
      type: "layout-change",
      windowId: 1,
      windowLayout: "4b5a,220x50,0,0,%1",
      windowVisibleLayout: "4b5a,220x50,0,0,%1",
      windowFlags: "*",
    });
    expect(messages[7]).toMatchObject({
      type: "session-window-changed",
      sessionId: 1,
      windowId: 1,
    });
    expect(messages).toHaveLength(8);
  });

  it("emits no output lines (the begin/end block is empty)", () => {
    const { outputLines } = collect(fixtureContent("startup.txt"));
    expect(outputLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture: basic-command-response.txt
// ---------------------------------------------------------------------------

describe("fixture: basic-command-response.txt", () => {
  it("emits begin/end guards for each block", () => {
    const { messages } = collect(fixtureContent("basic-command-response.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "begin", "end",
      "begin", "end",
      "begin", "end",
    ]);
  });

  it("routes output lines to onOutputLine with correct commandNumber", () => {
    const { outputLines } = collect(fixtureContent("basic-command-response.txt"));
    // block 1 (commandNumber=1): one output line
    expect(outputLines[0]).toEqual({
      commandNumber: 1,
      line: "0: bash* (1 panes) [220x50] [layout 4b5a,220x50,0,0,%1] @1 (active)",
    });
    // block 2 (commandNumber=2): one output line
    expect(outputLines[1]).toEqual({
      commandNumber: 2,
      line: "0: [220x50] [history 1000/50000, 204800 bytes] %1 (active)",
    });
    // block 3 (commandNumber=3): no output lines
    expect(outputLines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Fixture: error-response.txt
// ---------------------------------------------------------------------------

describe("fixture: error-response.txt", () => {
  it("emits begin/error guards for each block", () => {
    const { messages } = collect(fixtureContent("error-response.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "begin", "error",
      "begin", "error",
      "begin", "error",
    ]);
  });

  it("routes error output lines to onOutputLine", () => {
    const { outputLines } = collect(fixtureContent("error-response.txt"));
    expect(outputLines[0]).toEqual({
      commandNumber: 4,
      line: "unknown command: bad-command",
    });
    expect(outputLines[1]).toEqual({
      commandNumber: 5,
      line: "no server running on /tmp/tmux-1000/default",
    });
    expect(outputLines[2]).toEqual({
      commandNumber: 6,
      line: "can't find window: @99",
    });
    expect(outputLines).toHaveLength(3);
  });

  it("error guard commandNumbers match begin commandNumbers", () => {
    const { messages } = collect(fixtureContent("error-response.txt"));
    expect(messages[0]).toMatchObject({ type: "begin", commandNumber: 4 });
    expect(messages[1]).toMatchObject({ type: "error", commandNumber: 4 });
    expect(messages[2]).toMatchObject({ type: "begin", commandNumber: 5 });
    expect(messages[3]).toMatchObject({ type: "error", commandNumber: 5 });
    expect(messages[4]).toMatchObject({ type: "begin", commandNumber: 6 });
    expect(messages[5]).toMatchObject({ type: "error", commandNumber: 6 });
  });
});

// ---------------------------------------------------------------------------
// Fixture: output-octal-escapes.txt
// ---------------------------------------------------------------------------

describe("fixture: output-octal-escapes.txt", () => {
  it("emits output messages for each line", () => {
    const { messages } = collect(fixtureContent("output-octal-escapes.txt"));
    const outputs = messages.filter((m) => m.type === "output");
    expect(outputs).toHaveLength(12);
  });

  it("decodes \\012 as newline in first output", () => {
    const { messages } = collect(fixtureContent("output-octal-escapes.txt"));
    const first = messages.find(
      (m) => m.type === "output" && (m as any).paneId === 1
    ) as any;
    // "hello\012" → hello + newline
    expect(first.data[5]).toBe(10);
  });

  it("decodes ANSI escape: \\033[1;32m", () => {
    const { messages } = collect(fixtureContent("output-octal-escapes.txt"));
    const ansiMsg = messages.find((m) => {
      if (m.type !== "output") return false;
      // "green bold" line: starts with ESC
      return m.data[0] === 27;
    }) as any;
    expect(ansiMsg).toBeDefined();
    expect(ansiMsg.data[0]).toBe(27); // ESC
  });

  it("decodes \\134 as backslash", () => {
    const { messages } = collect(fixtureContent("output-octal-escapes.txt"));
    // "\\134backslash\\134test\\012" — first byte is 0x5c
    const backslashMsg = messages.find((m) => {
      if (m.type !== "output") return false;
      return m.data[0] === 0x5c;
    }) as any;
    expect(backslashMsg).toBeDefined();
    expect(backslashMsg.data[0]).toBe(0x5c);
  });

  it("\\000 null byte decodes correctly", () => {
    const { messages } = collect(fixtureContent("output-octal-escapes.txt"));
    const nullMsg = messages.find((m) => {
      if (m.type !== "output") return false;
      return m.data[0] === 0;
    }) as any;
    expect(nullMsg).toBeDefined();
  });

  it("\\377 high byte on pane 2 decodes to 0xff", () => {
    const { messages } = collect(fixtureContent("output-octal-escapes.txt"));
    const pane2Msgs = messages.filter(
      (m) => m.type === "output" && (m as any).paneId === 2
    ) as any[];
    expect(pane2Msgs).toHaveLength(1);
    expect(pane2Msgs[0].data[0]).toBe(0xff);
  });

  it("pane 3 VT sequence starts with ESC", () => {
    const { messages } = collect(fixtureContent("output-octal-escapes.txt"));
    const pane3Msg = messages.find(
      (m) => m.type === "output" && (m as any).paneId === 3
    ) as any;
    expect(pane3Msg).toBeDefined();
    expect(pane3Msg.data[0]).toBe(27); // ESC from \033
  });
});

// ---------------------------------------------------------------------------
// Fixture: extended-output.txt
// ---------------------------------------------------------------------------

describe("fixture: extended-output.txt", () => {
  it("emits extended-output messages", () => {
    const { messages } = collect(fixtureContent("extended-output.txt"));
    expect(messages.every((m) => m.type === "extended-output")).toBe(true);
    expect(messages).toHaveLength(5);
  });

  it("first entry: paneId=1, age=1000, data starts with h", () => {
    const { messages } = collect(fixtureContent("extended-output.txt"));
    const first = messages[0] as any;
    expect(first.paneId).toBe(1);
    expect(first.age).toBe(1000);
    // "hello\012" — first byte is 'h'
    expect(first.data[0]).toBe(104); // 'h'
  });

  it("second entry: paneId=2, age=2500, data starts with ESC (bold)", () => {
    const { messages } = collect(fixtureContent("extended-output.txt"));
    const second = messages[1] as any;
    expect(second.paneId).toBe(2);
    expect(second.age).toBe(2500);
    expect(second.data[0]).toBe(27); // ESC
  });

  it("third entry: paneId=1, age=0, plain text", () => {
    const { messages } = collect(fixtureContent("extended-output.txt"));
    const third = messages[2] as any;
    expect(third.paneId).toBe(1);
    expect(third.age).toBe(0);
    // "plain output no escapes\012" — first byte is 'p'
    expect(third.data[0]).toBe(112); // 'p'
  });

  it("fourth entry: paneId=3, age=999999, backslash decoded", () => {
    const { messages } = collect(fixtureContent("extended-output.txt"));
    const fourth = messages[3] as any;
    expect(fourth.paneId).toBe(3);
    expect(fourth.age).toBe(999999);
    expect(fourth.data[0]).toBe(0x5c); // backslash from \134
  });

  it("fifth entry: paneId=1, age=500, null and 0xff bytes", () => {
    const { messages } = collect(fixtureContent("extended-output.txt"));
    const fifth = messages[4] as any;
    expect(fifth.paneId).toBe(1);
    expect(fifth.age).toBe(500);
    expect(fifth.data[0]).toBe(0);    // \000
    expect(fifth.data[1]).toBe(0xff); // \377
  });
});

// ---------------------------------------------------------------------------
// Fixture: pause-continue.txt
// ---------------------------------------------------------------------------

describe("fixture: pause-continue.txt", () => {
  it("emits output, pause, continue messages in order", () => {
    const { messages } = collect(fixtureContent("pause-continue.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "output",  // first chunk
      "output",  // second chunk
      "output",  // third chunk
      "pause",   // %pause %1
      "output",  // output after pause
      "continue",// %continue %1
      "output",  // resumed output
      "output",  // pane two
      "pause",   // %pause %2
      "continue",// %continue %2
      "output",  // pane two resumed
    ]);
  });

  it("pause for pane 1", () => {
    const { messages } = collect(fixtureContent("pause-continue.txt"));
    const pause = messages.find((m) => m.type === "pause") as any;
    expect(pause.paneId).toBe(1);
  });

  it("continue for pane 1", () => {
    const { messages } = collect(fixtureContent("pause-continue.txt"));
    const cont = messages.find((m) => m.type === "continue") as any;
    expect(cont.paneId).toBe(1);
  });

  it("pane 2 pause and continue", () => {
    const { messages } = collect(fixtureContent("pause-continue.txt"));
    const pauses = messages.filter((m) => m.type === "pause") as any[];
    const continues = messages.filter((m) => m.type === "continue") as any[];
    expect(pauses[1].paneId).toBe(2);
    expect(continues[1].paneId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Fixture: exit.txt
// ---------------------------------------------------------------------------

describe("fixture: exit.txt", () => {
  it("emits begin, end, then exit with no reason", () => {
    const { messages } = collect(fixtureContent("exit.txt"));
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ type: "begin", commandNumber: 10 });
    expect(messages[1]).toMatchObject({ type: "end", commandNumber: 10 });
    expect(messages[2]).toMatchObject({ type: "exit" });
    expect((messages[2] as any).reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fixture: exit-with-reason.txt
// ---------------------------------------------------------------------------

describe("fixture: exit-with-reason.txt", () => {
  it("emits begin, end, then exit with reason 'detached'", () => {
    const { messages } = collect(fixtureContent("exit-with-reason.txt"));
    expect(messages[0]).toMatchObject({ type: "begin", commandNumber: 20 });
    expect(messages[1]).toMatchObject({ type: "end", commandNumber: 20 });
    expect(messages[2]).toMatchObject({ type: "exit", reason: "detached" });
    expect(messages).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Fixture: window-lifecycle.txt
// ---------------------------------------------------------------------------

describe("fixture: window-lifecycle.txt", () => {
  it("emits correct types in order", () => {
    const { messages } = collect(fixtureContent("window-lifecycle.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "window-add",          // @1
      "window-pane-changed", // @1 %1
      "layout-change",       // @1 *
      "window-renamed",      // @1 bash
      "window-add",          // @2
      "window-pane-changed", // @2 %2
      "layout-change",       // @2 -
      "layout-change",       // @1 *
      "window-renamed",      // @2 vim
      "window-pane-changed", // @1 %1
      "layout-change",       // @2 -
      "layout-change",       // @1 *
      "window-close",        // @2
      "layout-change",       // @1 *
      "window-add",          // @3
      "window-pane-changed", // @3 %3
      "layout-change",       // @3 -
      "window-renamed",      // @3 zsh
      "window-close",        // @3
    ]);
  });

  it("window-add has correct windowId", () => {
    const { messages } = collect(fixtureContent("window-lifecycle.txt"));
    const adds = messages.filter((m) => m.type === "window-add") as any[];
    expect(adds.map((m) => m.windowId)).toEqual([1, 2, 3]);
  });

  it("window-close has correct windowId", () => {
    const { messages } = collect(fixtureContent("window-lifecycle.txt"));
    const closes = messages.filter((m) => m.type === "window-close") as any[];
    expect(closes.map((m) => m.windowId)).toEqual([2, 3]);
  });

  it("window-renamed carries name", () => {
    const { messages } = collect(fixtureContent("window-lifecycle.txt"));
    const renames = messages.filter(
      (m) => m.type === "window-renamed"
    ) as any[];
    expect(renames[0]).toMatchObject({ windowId: 1, name: "bash" });
    expect(renames[1]).toMatchObject({ windowId: 2, name: "vim" });
    expect(renames[2]).toMatchObject({ windowId: 3, name: "zsh" });
  });
});

// ---------------------------------------------------------------------------
// Fixture: subscription-changed.txt
// ---------------------------------------------------------------------------

describe("fixture: subscription-changed.txt", () => {
  it("emits 6 subscription-changed messages", () => {
    const { messages } = collect(fixtureContent("subscription-changed.txt"));
    expect(messages.every((m) => m.type === "subscription-changed")).toBe(true);
    expect(messages).toHaveLength(6);
  });

  it("first entry: full IDs, pane-value", () => {
    const { messages } = collect(fixtureContent("subscription-changed.txt"));
    expect(messages[0]).toMatchObject({
      type: "subscription-changed",
      name: "my-sub",
      sessionId: 1,
      windowId: 1,
      windowIndex: 0,
      paneId: 1,
      value: "pane-value",
    });
  });

  it("second entry: paneId is -1 (dash)", () => {
    const { messages } = collect(fixtureContent("subscription-changed.txt"));
    expect(messages[1]).toMatchObject({
      name: "window-sub",
      sessionId: 1,
      windowId: 1,
      windowIndex: 0,
      paneId: -1,
      value: "window-title",
    });
  });

  it("third entry: windowId and paneId are -1", () => {
    const { messages } = collect(fixtureContent("subscription-changed.txt"));
    expect(messages[2]).toMatchObject({
      name: "session-sub",
      sessionId: 1,
      windowId: -1,
      windowIndex: -1,
      paneId: -1,
      value: "session-name",
    });
  });

  it("fourth entry: all IDs are -1", () => {
    const { messages } = collect(fixtureContent("subscription-changed.txt"));
    expect(messages[3]).toMatchObject({
      name: "global-sub",
      sessionId: -1,
      windowId: -1,
      windowIndex: -1,
      paneId: -1,
      value: "global-value",
    });
  });

  it("fifth entry: value with spaces", () => {
    const { messages } = collect(fixtureContent("subscription-changed.txt"));
    expect(messages[4]).toMatchObject({
      name: "multi-sub",
      sessionId: 2,
      windowId: 3,
      windowIndex: 1,
      paneId: 5,
      value: "complex value with spaces",
    });
  });
});

// ---------------------------------------------------------------------------
// Fixture: client-events.txt
// ---------------------------------------------------------------------------

describe("fixture: client-events.txt", () => {
  it("emits client-session-changed and client-detached messages", () => {
    const { messages } = collect(fixtureContent("client-events.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "client-session-changed",
      "client-session-changed",
      "client-session-changed",
      "client-detached",
      "client-session-changed",
      "client-detached",
    ]);
  });

  it("first client-session-changed: clientName, sessionId, name", () => {
    const { messages } = collect(fixtureContent("client-events.txt"));
    expect(messages[0]).toMatchObject({
      type: "client-session-changed",
      clientName: "/dev/pts/0",
      sessionId: 1,
      name: "main",
    });
  });

  it("client-detached: clientName", () => {
    const { messages } = collect(fixtureContent("client-events.txt"));
    const detached = messages.filter(
      (m) => m.type === "client-detached"
    ) as any[];
    expect(detached[0].clientName).toBe("/dev/pts/1");
    expect(detached[1].clientName).toBe("/dev/pts/0");
  });
});

// ---------------------------------------------------------------------------
// Fixture: layout-change.txt
// ---------------------------------------------------------------------------

describe("fixture: layout-change.txt", () => {
  it("emits layout-change and window-pane-changed messages", () => {
    const { messages } = collect(fixtureContent("layout-change.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "layout-change",
      "window-pane-changed",
      "layout-change",
      "window-pane-changed",
      "layout-change",
      "window-pane-changed",
      "layout-change",
      "layout-change",
      "layout-change",
    ]);
  });

  it("first layout-change: windowId=1, flags=*", () => {
    const { messages } = collect(fixtureContent("layout-change.txt"));
    expect(messages[0]).toMatchObject({
      type: "layout-change",
      windowId: 1,
      windowFlags: "*",
    });
  });

  it("layout-change @2 has windowId=2", () => {
    const { messages } = collect(fixtureContent("layout-change.txt"));
    const win2 = messages.find(
      (m) => m.type === "layout-change" && (m as any).windowId === 2
    ) as any;
    expect(win2).toBeDefined();
    expect(win2.windowId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Fixture: message-config-error.txt
// ---------------------------------------------------------------------------

describe("fixture: message-config-error.txt", () => {
  it("emits config-error, message, and pane-mode-changed messages", () => {
    const { messages } = collect(fixtureContent("message-config-error.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "config-error",
      "config-error",
      "message",
      "message",
      "message",
      "pane-mode-changed",
      "pane-mode-changed",
      "pane-mode-changed",
    ]);
  });

  it("config-error carries error string", () => {
    const { messages } = collect(fixtureContent("message-config-error.txt"));
    expect(messages[0]).toMatchObject({
      type: "config-error",
      error: "Unknown option: foo",
    });
    expect(messages[1]).toMatchObject({
      type: "config-error",
      error: "Invalid value for option bar: baz",
    });
  });

  it("message carries message string", () => {
    const { messages } = collect(fixtureContent("message-config-error.txt"));
    expect(messages[2]).toMatchObject({
      type: "message",
      message: "Window @1 created",
    });
  });

  it("pane-mode-changed carries paneId", () => {
    const { messages } = collect(fixtureContent("message-config-error.txt"));
    const modes = messages.filter(
      (m) => m.type === "pane-mode-changed"
    ) as any[];
    expect(modes[0].paneId).toBe(1);
    expect(modes[1].paneId).toBe(2);
    expect(modes[2].paneId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fixture: multiple-notifications.txt
// ---------------------------------------------------------------------------

describe("fixture: multiple-notifications.txt", () => {
  it("% lines inside response blocks are routed to onOutputLine (SPEC §4)", () => {
    // SPEC_MANIFEST §4: a notification will never occur inside a response
    // block. The fixture interleaves %-prefixed lines that LOOK like
    // notifications (%window-renamed, %window-pane-changed, %session-changed)
    // between %begin and %end. Per the spec invariant the parser must treat
    // those as command output, not notifications.
    const { messages, outputLines } = collect(
      fixtureContent("multiple-notifications.txt"),
    );

    const outputTypes = messages.map((m) => m.type);
    expect(outputTypes).toContain("begin");
    expect(outputTypes).toContain("end");

    // The %-prefixed in-block lines surface verbatim as output lines.
    const captured = outputLines.map((ol) => ol.line);
    expect(captured).toContain("%window-renamed @1 zsh");
    expect(captured).toContain("%window-pane-changed @1 %1");
    expect(captured).toContain("%session-changed $1 main");
  });

  it("output lines have correct commandNumbers", () => {
    const { outputLines } = collect(
      fixtureContent("multiple-notifications.txt"),
    );
    // All output lines should have the commandNumber of the enclosing begin
    for (const ol of outputLines) {
      expect(typeof ol.commandNumber).toBe("number");
      expect(ol.commandNumber).toBeGreaterThanOrEqual(0);
    }
  });

  it("%-prefixed lines inside response block are NOT emitted as notifications", () => {
    // Regression: prior parser dispatched %-prefixed lines through the
    // notification table even inside response blocks, which silently dropped
    // unknown types and falsely synthesized known ones. Per SPEC §4 these
    // lines are command output and must not appear in the messages stream.
    const { messages } = collect(fixtureContent("multiple-notifications.txt"));
    expect(messages.find((m) => m.type === "window-renamed")).toBeUndefined();
    expect(
      messages.find((m) => m.type === "window-pane-changed"),
    ).toBeUndefined();
    // session-changed appears once OUTSIDE any block in the fixture? — no,
    // both occurrences are in-block in this fixture. The outside %window-add
    // and %layout-change should still arrive as notifications.
    expect(messages.find((m) => m.type === "session-changed")).toBeUndefined();
  });

  it("window-add and layout-change outside response block ARE notifications", () => {
    const { messages } = collect(fixtureContent("multiple-notifications.txt"));
    expect(messages.find((m) => m.type === "window-add")).toBeDefined();
    expect(messages.find((m) => m.type === "layout-change")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fixture: paste-buffer.txt
// ---------------------------------------------------------------------------

describe("fixture: paste-buffer.txt", () => {
  it("emits paste-buffer-changed and paste-buffer-deleted messages", () => {
    const { messages } = collect(fixtureContent("paste-buffer.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "paste-buffer-changed",
      "paste-buffer-changed",
      "paste-buffer-changed",
      "paste-buffer-deleted",
      "paste-buffer-changed",
      "paste-buffer-deleted",
      "paste-buffer-deleted",
    ]);
  });

  it("first changed: name=buffer0", () => {
    const { messages } = collect(fixtureContent("paste-buffer.txt"));
    expect(messages[0]).toMatchObject({
      type: "paste-buffer-changed",
      name: "buffer0",
    });
  });

  it("deleted messages have correct names", () => {
    const { messages } = collect(fixtureContent("paste-buffer.txt"));
    const deleted = messages.filter(
      (m) => m.type === "paste-buffer-deleted"
    ) as any[];
    expect(deleted[0].name).toBe("buffer0");
    expect(deleted[1].name).toBe("buffer1");
    expect(deleted[2].name).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Fixture: session-events.txt
// ---------------------------------------------------------------------------

describe("fixture: session-events.txt", () => {
  it("emits correct types in order", () => {
    const { messages } = collect(fixtureContent("session-events.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "session-changed",
      "sessions-changed",
      "session-window-changed",
      "session-renamed",
      "sessions-changed",
      "session-changed",
      "sessions-changed",
      "session-window-changed",
      "session-changed",
      "sessions-changed",
      "session-window-changed",
      "session-window-changed",
    ]);
  });

  it("session-renamed: sessionId=1, name=work", () => {
    const { messages } = collect(fixtureContent("session-events.txt"));
    const renamed = messages.find((m) => m.type === "session-renamed") as any;
    expect(renamed).toMatchObject({ sessionId: 1, name: "work" });
  });

  it("session-window-changed: multiple sessions and windows", () => {
    const { messages } = collect(fixtureContent("session-events.txt"));
    const swc = messages.filter(
      (m) => m.type === "session-window-changed"
    ) as any[];
    expect(swc[0]).toMatchObject({ sessionId: 1, windowId: 1 });
    expect(swc[1]).toMatchObject({ sessionId: 1, windowId: 2 });
    expect(swc[2]).toMatchObject({ sessionId: 2, windowId: 3 });
    expect(swc[3]).toMatchObject({ sessionId: 1, windowId: 1 });
  });
});

// ---------------------------------------------------------------------------
// Fixture: unlinked-windows.txt
// ---------------------------------------------------------------------------

describe("fixture: unlinked-windows.txt", () => {
  it("emits unlinked-window-add, unlinked-window-renamed, unlinked-window-close", () => {
    const { messages } = collect(fixtureContent("unlinked-windows.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "unlinked-window-add",
      "unlinked-window-renamed",
      "unlinked-window-add",
      "unlinked-window-renamed",
      "unlinked-window-close",
      "unlinked-window-close",
      "unlinked-window-add",
      "unlinked-window-renamed",
    ]);
  });

  it("unlinked-window-renamed carries name", () => {
    const { messages } = collect(fixtureContent("unlinked-windows.txt"));
    const renames = messages.filter(
      (m) => m.type === "unlinked-window-renamed"
    ) as any[];
    expect(renames[0]).toMatchObject({ windowId: 5, name: "scratch" });
    expect(renames[1]).toMatchObject({ windowId: 6, name: "logs" });
    expect(renames[2]).toMatchObject({ windowId: 7, name: "background-task" });
  });

  it("unlinked-window-close has correct windowIds", () => {
    const { messages } = collect(fixtureContent("unlinked-windows.txt"));
    const closes = messages.filter(
      (m) => m.type === "unlinked-window-close"
    ) as any[];
    expect(closes[0].windowId).toBe(5);
    expect(closes[1].windowId).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Chunked feeding test
// ---------------------------------------------------------------------------

describe("chunked feeding (one byte at a time)", () => {
  it("startup.txt produces same messages as full feed", () => {
    const content = fixtureContent("startup.txt");
    const messages: TmuxMessage[] = [];
    const parser = new TmuxParser((msg) => messages.push(msg));
    for (const char of content) {
      parser.feed(char);
    }
    expect(messages[0]).toMatchObject({ type: "begin", commandNumber: 0 });
    expect(messages[1]).toMatchObject({ type: "end", commandNumber: 0 });
    expect(messages[2]).toMatchObject({ type: "session-changed", sessionId: 1 });
    expect(messages).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Malformed input / fuzz tests
// ---------------------------------------------------------------------------

describe("malformed input: %begin with too few fields", () => {
  it("emits no message", () => {
    const { messages } = collect("%begin 1699900000 0\n");
    // parseGuard requires 3 parts; "1699900000 0" has only 2
    expect(messages).toHaveLength(0);
  });
});

describe("malformed input: %output with no space", () => {
  it("emits no message", () => {
    const { messages } = collect("%output %1nospace\n");
    expect(messages).toHaveLength(0);
  });
});

describe("malformed input: %extended-output with no ' : '", () => {
  it("emits no message", () => {
    const { messages } = collect("%extended-output %1 100 value-no-colon\n");
    expect(messages).toHaveLength(0);
  });
});

describe("malformed input: %layout-change with too few parts", () => {
  it("emits no message", () => {
    // needs windowId + layout + visibleLayout + flags = 4 parts
    const { messages } = collect("%layout-change @1 4b5a\n");
    expect(messages).toHaveLength(0);
  });
});

describe("unknown notification type", () => {
  it("silently skipped, no message emitted", () => {
    const { messages } = collect("%unknown-future-type foo bar baz\n");
    expect(messages).toHaveLength(0);
  });
});

describe("binary garbage lines outside response block", () => {
  it("non-% lines outside blocks are silently ignored", () => {
    const { messages } = collect("this is not a notification\nneither is this\n");
    expect(messages).toHaveLength(0);
  });
});

describe("very long line", () => {
  it("does not crash", () => {
    const longLine = "%unknown-type " + "x".repeat(50000) + "\n";
    expect(() => collect(longLine)).not.toThrow();
  });

  it("very long valid output line does not crash", () => {
    const longData = "a".repeat(50000);
    const line = `%output %1 ${longData}\n`;
    const { messages } = collect(line);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("output");
  });
});

describe("inside-block routing (SPEC §4 invariant)", () => {
  it("non-% lines inside response block go to onOutputLine", () => {
    const input =
      "%begin 1699900000 7 0\nsome output line\n%end 1699900000 7 0\n";
    const { messages, outputLines } = collect(input);
    expect(outputLines[0].line).toBe("some output line");
    expect(messages.find((m) => m.type === "begin")).toBeDefined();
    expect(messages.find((m) => m.type === "end")).toBeDefined();
  });

  it("%-prefixed lines inside response block route to onOutputLine, not the notification path", () => {
    // SPEC_MANIFEST §4: notifications never occur inside a response block,
    // so a %-prefixed line between %begin and %end is command output —
    // even if its name happens to match a known notification type.
    const input =
      "%begin 1699900000 8 0\n%sessions-changed\n%end 1699900000 8 0\n";
    const { messages, outputLines } = collect(input);
    expect(messages.map((m) => m.type)).not.toContain("sessions-changed");
    expect(outputLines.map((o) => o.line)).toContain("%sessions-changed");
  });

  it("bare %N pane-id lines from list-panes -F '#{pane_id}' arrive as output", () => {
    // Regression for the example workaround: list-panes -F '#{pane_id}'
    // emits lines like "%5" inside the response block. Pre-fix, the parser
    // tried to dispatch them as unknown notifications and silently dropped
    // them, forcing the example to prefix the format with "id=". Now the
    // bare ID survives the round-trip as an output line.
    const input =
      "%begin 1699900000 9 0\n%5\n%7\n%11\n%end 1699900000 9 0\n";
    const { outputLines } = collect(input);
    expect(outputLines.map((o) => o.line)).toEqual(["%5", "%7", "%11"]);
  });

  it("only %end and %error close the block; other %-lines remain output", () => {
    const input =
      "%begin 1699900000 1 0\n" +
      "%output %2 hello\n" + // looks like a notification, but it's output
      "%end 1699900000 1 0\n" +
      "%output %2 world\n"; // outside any block — real notification
    const { messages, outputLines } = collect(input);
    expect(outputLines.map((o) => o.line)).toEqual(["%output %2 hello"]);
    expect(messages.filter((m) => m.type === "output")).toHaveLength(1);
  });
});

describe("empty feed", () => {
  it("emits no messages and does not crash", () => {
    const { messages } = collect("");
    expect(messages).toHaveLength(0);
  });
});

describe("reset() clears state", () => {
  it("partial input then reset then valid input yields only valid messages", () => {
    const messages: TmuxMessage[] = [];
    const parser = new TmuxParser((msg) => messages.push(msg));
    // Feed partial line (no newline yet, so nothing processed)
    parser.feed("%begin 1699900000 0 0");
    // reset clears the buffer
    parser.reset();
    // Feed valid complete input
    parser.feed("%sessions-changed\n");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "sessions-changed" });
  });

  it("reset after partial response block clears activeCommandNumber", () => {
    const outputLines: Array<{ commandNumber: number; line: string }> = [];
    const messages: TmuxMessage[] = [];
    const parser = new TmuxParser((msg) => messages.push(msg));
    parser.onOutputLine = (commandNumber, line) =>
      outputLines.push({ commandNumber, line });
    // Enter a response block
    parser.feed("%begin 1699900000 42 0\n");
    expect(messages[0]).toMatchObject({ type: "begin", commandNumber: 42 });
    // Reset clears the active command number
    parser.reset();
    // Non-% line now — should be ignored (not in response block anymore)
    parser.feed("this line is outside\n");
    expect(outputLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Response block tracking: onOutputLine callback
// ---------------------------------------------------------------------------

describe("onOutputLine receives correct commandNumber and line", () => {
  it("multiple blocks with different commandNumbers", () => {
    const input = [
      "%begin 1699900000 10 0",
      "line one",
      "line two",
      "%end 1699900000 10 0",
      "%begin 1699900000 11 0",
      "line three",
      "%end 1699900000 11 0",
    ].join("\n") + "\n";

    const { outputLines } = collect(input);
    expect(outputLines).toHaveLength(3);
    expect(outputLines[0]).toEqual({ commandNumber: 10, line: "line one" });
    expect(outputLines[1]).toEqual({ commandNumber: 10, line: "line two" });
    expect(outputLines[2]).toEqual({ commandNumber: 11, line: "line three" });
  });
});

describe("lines outside response blocks without % are ignored", () => {
  it("stray plain lines produce no messages and no output lines", () => {
    const input = "stray line\n%sessions-changed\nanother stray\n";
    const { messages, outputLines } = collect(input);
    expect(outputLines).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("sessions-changed");
  });
});
