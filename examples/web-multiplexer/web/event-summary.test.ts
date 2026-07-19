// examples/web-multiplexer/web/event-summary.test.ts
//
// Isolation tests for the inspector's one-line event summarizer. Pure:
// a TmuxMessage plus a label map in, one display line out — no MobX, no
// client. These pin the per-type summary shapes and the pane-label
// fallback the Protocol Inspector timeline rides on. [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import type { TmuxMessage } from "@promptctl/tmux-control-mode-js";
import { summarizeEvent } from "./event-summary.ts";

const labels = new Map<number, string>([[5, "$0:@1.%5"]]);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("summarizeEvent — pane label", () => {
  it("uses the label map for a known pane id", () => {
    const ev: TmuxMessage = { type: "output", paneId: 5, data: bytes("hi") };
    expect(summarizeEvent(ev, labels)).toBe(`$0:@1.%5  "hi"`);
  });

  it("falls back to %<id> for an unknown pane id", () => {
    const ev: TmuxMessage = { type: "output", paneId: 9, data: bytes("hi") };
    expect(summarizeEvent(ev, labels)).toBe(`%9  "hi"`);
  });
});

describe("summarizeEvent — byte previews stay single-line short", () => {
  it("caps the output preview at 64 bytes", () => {
    const long = "x".repeat(200);
    const ev: TmuxMessage = { type: "output", paneId: 9, data: bytes(long) };
    const out = summarizeEvent(ev, labels);
    // The preview is truncated well under the raw length; the timeline
    // is a dense one-line table so this must never blow out.
    expect(out.length).toBeLessThan(120);
  });

  it("renders extended-output with an age tag", () => {
    const ev: TmuxMessage = {
      type: "extended-output",
      paneId: 9,
      age: 42,
      data: bytes("y"),
    };
    expect(summarizeEvent(ev, labels)).toBe(`%9 age=42ms  "y"`);
  });
});

describe("summarizeEvent — window / session / client shapes", () => {
  it("summarizes window-renamed as id → name", () => {
    const ev: TmuxMessage = {
      type: "window-renamed",
      windowId: 3,
      name: "logs",
    };
    expect(summarizeEvent(ev, labels)).toBe(`@3 → "logs"`);
  });

  it("summarizes window-pane-changed terse (no 'active' verbiage)", () => {
    const ev: TmuxMessage = {
      type: "window-pane-changed",
      windowId: 3,
      paneId: 5,
    };
    expect(summarizeEvent(ev, labels)).toBe(`@3 → $0:@1.%5`);
  });

  it("summarizes session-changed as $id name", () => {
    const ev: TmuxMessage = {
      type: "session-changed",
      sessionId: 2,
      name: "main",
    };
    expect(summarizeEvent(ev, labels)).toBe(`$2 "main"`);
  });

  it("summarizes subscription-changed without the trailing value", () => {
    const ev: TmuxMessage = {
      type: "subscription-changed",
      name: "panes",
      sessionId: 0,
      windowId: 1,
      windowIndex: 0,
      paneId: 5,
      value: "ignored-by-inspector",
    };
    expect(summarizeEvent(ev, labels)).toBe(`"panes" $0:@1.$0:@1.%5`);
  });
});

describe("summarizeEvent — exit and empty fallthrough", () => {
  it("shows the exit reason, or (clean) when absent", () => {
    expect(summarizeEvent({ type: "exit", reason: "boom" }, labels)).toBe(
      "boom",
    );
    expect(summarizeEvent({ type: "exit" }, labels)).toBe("(clean)");
  });

  it("returns the empty string for a fieldless event", () => {
    expect(summarizeEvent({ type: "sessions-changed" }, labels)).toBe("");
  });
});

// One representative per remaining branch, so every arm of the summarizer
// has its contract pinned before SD5 consolidates the three copies.
describe("summarizeEvent — full branch coverage", () => {
  const cases: ReadonlyArray<readonly [TmuxMessage, string]> = [
    [{ type: "pause", paneId: 5 }, "$0:@1.%5"],
    [{ type: "continue", paneId: 9 }, "%9"],
    [{ type: "pane-mode-changed", paneId: 5 }, "$0:@1.%5"],
    [{ type: "window-add", windowId: 3 }, "@3"],
    [{ type: "window-close", windowId: 3 }, "@3"],
    [{ type: "unlinked-window-add", windowId: 4 }, "@4"],
    [{ type: "unlinked-window-close", windowId: 4 }, "@4"],
    [
      {
        type: "layout-change",
        windowId: 3,
        windowLayout: "abcd,80x24",
        windowVisibleLayout: "abcd,80x24",
        windowFlags: "*",
      },
      "@3 layout=abcd,80x24",
    ],
    [{ type: "session-renamed", sessionId: 2, name: "work" }, `$2 "work"`],
    [{ type: "session-window-changed", sessionId: 2, windowId: 3 }, "$2 → @3"],
    [
      {
        type: "client-session-changed",
        clientName: "cli",
        sessionId: 2,
        name: "work",
      },
      `cli → $2 "work"`,
    ],
    [{ type: "client-detached", clientName: "cli" }, "cli"],
    [{ type: "begin", timestamp: 0, commandNumber: 7, flags: 0 }, "cmd #7"],
    [{ type: "end", timestamp: 0, commandNumber: 7, flags: 0 }, "cmd #7"],
    [{ type: "error", timestamp: 0, commandNumber: 7, flags: 0 }, "cmd #7"],
    [{ type: "message", message: "hello" }, "hello"],
    [{ type: "config-error", error: "bad config" }, "bad config"],
    [{ type: "paste-buffer-changed", name: "buffer0" }, "buffer0"],
    [{ type: "paste-buffer-deleted", name: "buffer0" }, "buffer0"],
  ];

  it.each(cases)("summarizes %o", (ev, expected) => {
    expect(summarizeEvent(ev, labels)).toBe(expected);
  });
});
