import { describe, expect, it } from "vitest";
import { TmuxReplyFormatError, type PaneRecord } from "../../../src/browser.js";
import {
  parseFlags,
  parseMembership,
  parsePaneMeta,
  parseSnapshot,
  snapshotCommand,
} from "../../../src/window-terminal/engine/bootstrap.js";
import { TWO_PANES } from "../../helpers/layout.js";

function pane(windowId: number, paneId: number, title: string): PaneRecord {
  return {
    sessionId: 1,
    sessionName: "main",
    windowId,
    windowName: "w",
    paneId,
    process: { state: "running", pid: 1, cwd: "/", currentCommand: "vim" },
    startCommand: "",
    width: 40,
    height: 24,
    title,
  };
}

describe("bootstrap — membership", () => {
  it("attached, elsewhere on the server, or nowhere", () => {
    expect(parseMembership("@1", ["@0", "@1"], ["@0", "@1"])).toBe("attached");
    expect(parseMembership("@1", ["@0"], ["@0", "@1"])).toBe(
      "window-unreachable",
    );
    expect(parseMembership("@1", ["@0"], ["@0"])).toBe("window-closed");
  });

  it("a line that is not a window id throws TmuxReplyFormatError", () => {
    expect(() => parseMembership("@1", ["1"], [])).toThrow(
      TmuxReplyFormatError,
    );
  });
});

describe("bootstrap — subscription values", () => {
  it("flags are three 0/1 digits", () => {
    expect(parseFlags("010")).toEqual({
      bell: false,
      activity: true,
      silence: false,
    });
    expect(parseFlags("01")).toBeNull();
  });

  it("pane meta splits at the first tab and decodes UTF-8", () => {
    expect(parsePaneMeta("cafÃ©\tmy\tcmd")).toEqual({
      title: "café",
      command: "my\tcmd",
    });
    expect(parsePaneMeta("no tab")).toBeNull();
  });
});

describe("bootstrap — snapshot", () => {
  it("reads the layout, name, active pane, flags and this window's pane meta", () => {
    const reply = [`${TWO_PANES}\t${TWO_PANES}\t*\tcafÃ©\t%1\t100`];
    const snap = parseSnapshot("@1", reply, [
      pane(1, 0, "left"),
      pane(1, 1, "right"),
      pane(2, 5, "elsewhere"),
    ]);
    expect(snap.name).toBe("café");
    expect(snap.active).toBe("%1");
    expect(snap.flags).toEqual({ bell: true, activity: false, silence: false });
    expect(snap.layout.layout.kind).toBe("parsed");
    expect([...snap.meta]).toEqual([
      ["%0", { title: "left", command: "vim" }],
      ["%1", { title: "right", command: "vim" }],
    ]);
  });

  it("a command's control bytes read ?, as the meta subscription delivers them", () => {
    const reply = [`${TWO_PANES}\t${TWO_PANES}\t*\tw\t%0\t000`];
    const named = pane(1, 0, "t");
    const snap = parseSnapshot("@1", reply, [
      {
        ...named,
        process: { ...named.process, currentCommand: "x\n%exit\t\x7f" },
      } as PaneRecord,
    ]);
    expect(snap.meta.get("%0")?.command).toBe("x?%exit??");
  });

  it("a reply of the wrong shape throws, carrying the command", () => {
    for (const reply of [[], ["a\tb"], [`x\tx\t*\tn\tnot-a-pane\t000`]]) {
      expect(() => parseSnapshot("@1", reply, [])).toThrow(
        expect.objectContaining({ command: snapshotCommand("@1") }),
      );
    }
  });
});
