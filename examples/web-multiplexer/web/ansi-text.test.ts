// examples/web-multiplexer/web/ansi-text.test.ts
import { describe, it, expect } from "vitest";
import { stripAnsi, LineAssembler } from "./ansi-text.ts";

describe("stripAnsi", () => {
  it("removes SGR color sequences, keeping the visible text", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  it("removes cursor-movement CSI sequences", () => {
    expect(stripAnsi("a\x1b[2Kb\x1b[1;1Hc")).toBe("abc");
  });

  it("removes OSC sequences terminated by BEL or ST", () => {
    expect(stripAnsi("\x1b]0;window title\x07after")).toBe("after");
    expect(stripAnsi("pre\x1b]8;;https://x\x1b\\link")).toBe("prelink");
  });

  it("drops carriage returns and other C0 controls but keeps tabs", () => {
    expect(stripAnsi("col1\tcol2\r")).toBe("col1\tcol2");
    expect(stripAnsi("a\x00\x07b")).toBe("ab");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("just plain text 123")).toBe("just plain text 123");
  });
});

describe("LineAssembler", () => {
  it("emits a line only once its newline arrives", () => {
    const a = new LineAssembler();
    expect(a.push("hello")).toEqual([]);
    expect(a.push(" world\n")).toEqual(["hello world"]);
  });

  it("reassembles a line split across many chunks", () => {
    const a = new LineAssembler();
    a.push("the qu");
    a.push("ick brown");
    expect(a.push(" fox\nnext")).toEqual(["the quick brown fox"]);
  });

  it("emits multiple complete lines from one chunk", () => {
    const a = new LineAssembler();
    expect(a.push("one\ntwo\nthree\n")).toEqual(["one", "two", "three"]);
  });

  it("strips ANSI inside reassembled lines", () => {
    const a = new LineAssembler();
    expect(a.push("\x1b[32mok\x1b[0m\r\n")).toEqual(["ok"]);
  });

  it("flush() returns the trailing partial line, then clears", () => {
    const a = new LineAssembler();
    a.push("partial");
    expect(a.flush()).toBe("partial");
    expect(a.flush()).toBeNull();
  });
});
