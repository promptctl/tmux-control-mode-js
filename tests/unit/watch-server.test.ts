// tests/unit/watch-server.test.ts
// watchServerArgs argv and the own-client reply grammar — tmux-server-events-6sp.s3u.

import { describe, it, expect } from "vitest";
import { watchServerArgs } from "../../src/watch-server.js";
import { parseOwnClientLine } from "../../src/commands/index.js";

describe("watchServerArgs", () => {
  it("attaches to the named session with the non-disturbing client flags", () => {
    expect(watchServerArgs("main")).toEqual([
      "attach-session",
      "-t",
      "main",
      "-f",
      "ignore-size,no-detach-on-destroy",
    ]);
  });
});

describe("parseOwnClientLine", () => {
  it("parses a control client's identity", () => {
    expect(
      parseOwnClientLine([
        "4242 attached,focused,control-mode,ignore-size,UTF-8 client-4242",
      ]),
    ).toEqual({
      pid: 4242,
      flags: ["attached", "focused", "control-mode", "ignore-size", "UTF-8"],
      name: "client-4242",
    });
  });

  it("keeps a tty-path name whole", () => {
    expect(parseOwnClientLine(["7 attached /dev/ttys001"]).name).toBe(
      "/dev/ttys001",
    );
  });

  it.each([[[]], [["not a reply"]], [["1 flags"]], [["1 a x", "2 b y"]]])(
    "throws on a malformed reply %j",
    (lines) => {
      expect(() => parseOwnClientLine(lines)).toThrow(/own-client reply/);
    },
  );
});
