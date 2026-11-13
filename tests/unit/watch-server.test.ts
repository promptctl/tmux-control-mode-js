// tests/unit/watch-server.test.ts
// watchServerArgs argv and the own-client reply grammar — tmux-server-events-6sp.s3u, 6sp.6fc.

import { describe, it, expect } from "vitest";
import { watchServerArgs } from "../../src/watch-server.js";
import { parseOwnClientLine } from "../../src/commands/index.js";
import { TmuxReplyFormatError } from "../../src/errors.js";

describe("watchServerArgs", () => {
  const nonDisturbing = [
    "-N",
    "attach-session",
    "-E",
    "-f",
    "ignore-size,no-detach-on-destroy",
  ];

  it("attaches to the named session, matched exactly", () => {
    expect(watchServerArgs("main")).toEqual([...nonDisturbing, "-t", "=main"]);
  });

  it("names no session when given none, leaving the pick to tmux", () => {
    expect(watchServerArgs()).toEqual(nonDisturbing);
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
      expect(() => parseOwnClientLine(lines)).toThrow(TmuxReplyFormatError);
    },
  );
});
