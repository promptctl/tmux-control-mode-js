// tests/unit/command-version-gates.test.ts
//
// [LAW:verifiable-goals] The library supports tmux 3.2+, but some commands are
// newer: `requestReport` emits `refresh-client -r` (tmux 3.5), and
// `queryClipboard` emits `refresh-client -l`, which kills the control client on
// tmux 3.2. Each command probes the live tmux version over the control-mode
// connection and rejects with a typed precondition error below its floor,
// never sending the command. These tests pin that behavior with a fake
// connection, so the rejection is verified without owning an old tmux binary.

import { describe, it, expect } from "vitest";
import {
  requestReport,
  queryClipboard,
  queryTmuxVersion,
  paneCwd,
} from "../../src/commands/index.js";
import {
  PaneCwdUnavailableError,
  TmuxReplyFormatError,
  UnrecognizedTmuxVersionError,
  UnsupportedTmuxVersionError,
} from "../../src/errors.js";
import type { TmuxConnection } from "../../src/client.js";
import type { CommandResponse } from "../../src/protocol/types.js";

// Minimal TmuxConnection fake: records every command string and answers the
// version probe with a configurable version line. Every other command resolves
// to a success carrying `otherReply` (empty by default). on/off/attachBytesSink
// are unused by the command free-functions and are inert here.
function fakeConnection(
  versionReply: string | string[],
  otherReply: string[] = [],
): {
  conn: TmuxConnection;
  sent: string[];
} {
  const sent: string[] = [];
  const respond = (output: string[]): CommandResponse => ({
    commandNumber: sent.length,
    timestamp: 0,
    output,
    success: true,
  });
  const conn: TmuxConnection = {
    execute(command: string): Promise<CommandResponse> {
      sent.push(command);
      if (command.includes("#{version}")) {
        return Promise.resolve(
          respond(
            typeof versionReply === "string" ? [versionReply] : versionReply,
          ),
        );
      }
      return Promise.resolve(respond(otherReply));
    },
    on() {},
    off() {},
    attachBytesSink() {
      return () => {};
    },
    connectionState: { status: "ready" },
  };
  return { conn, sent };
}

describe("requestReport version gate", () => {
  it("rejects on tmux 3.4 with UnsupportedTmuxVersionError and never sends refresh-client -r", async () => {
    const { conn, sent } = fakeConnection("3.4");

    await expect(
      requestReport(conn, 1, "\x1b]10;?\x07"),
    ).rejects.toBeInstanceOf(UnsupportedTmuxVersionError);

    // The probe was sent; the report command was NOT.
    expect(sent.some((c) => c.includes("#{version}"))).toBe(true);
    expect(sent.some((c) => c.startsWith("refresh-client -r"))).toBe(false);
  });

  it("carries the required and actual versions on the error", async () => {
    const { conn } = fakeConnection("3.2");
    await requestReport(conn, 1, "report").catch((err: unknown) => {
      expect(err).toBeInstanceOf(UnsupportedTmuxVersionError);
      const e = err as UnsupportedTmuxVersionError;
      expect(e.required).toEqual({ major: 3, minor: 5 });
      expect(e.actual).toEqual({ major: 3, minor: 2 });
    });
  });

  it("proceeds to send refresh-client -r on tmux 3.5", async () => {
    const { conn, sent } = fakeConnection("3.5");

    await requestReport(conn, 7, "report-body");

    expect(sent.some((c) => c.startsWith("refresh-client -r '%7:"))).toBe(true);
  });

  it("accepts a version suffix (3.5a) — parse ignores trailing letters", async () => {
    const { conn, sent } = fakeConnection("3.5a");
    await requestReport(conn, 2, "r");
    expect(sent.some((c) => c.startsWith("refresh-client -r"))).toBe(true);
  });

  it("proceeds on a newer major (4.0) even though its minor is below 5", async () => {
    const { conn, sent } = fakeConnection("4.0");
    await requestReport(conn, 3, "r");
    expect(sent.some((c) => c.startsWith("refresh-client -r"))).toBe(true);
  });

  it("queryTmuxVersion rejects loudly when the reply carries no version", async () => {
    const { conn } = fakeConnection("no version here");
    await expect(queryTmuxVersion(conn)).rejects.toThrow(
      UnrecognizedTmuxVersionError,
    );
  });

  it("queryTmuxVersion refuses a progname prefix — #{version} is always bare", async () => {
    const { conn } = fakeConnection("tmux 3.5");
    await expect(queryTmuxVersion(conn)).rejects.toThrow(
      UnrecognizedTmuxVersionError,
    );
  });

  it.each([[[]], [["3.5", "3.4"]]])(
    "queryTmuxVersion treats a reply of %j as a reply-shape error, not a version",
    async (reply) => {
      const { conn } = fakeConnection(reply);
      await expect(queryTmuxVersion(conn)).rejects.toThrow(
        TmuxReplyFormatError,
      );
    },
  );

  it("refuses a vendor version tag (openbsd-7.4) with the raw reply and never sends the gated command", async () => {
    const { conn, sent } = fakeConnection("openbsd-7.4");
    const err: unknown = await requestReport(conn, 1, "r").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnrecognizedTmuxVersionError);
    expect((err as UnrecognizedTmuxVersionError).reported).toEqual([
      "openbsd-7.4",
    ]);
    expect(sent.some((c) => c.startsWith("refresh-client -r"))).toBe(false);
  });
});

describe("queryClipboard version gate", () => {
  it("rejects on tmux 3.2 with the 3.3 requirement and never sends refresh-client -l", async () => {
    const { conn, sent } = fakeConnection("3.2a");

    const err: unknown = await queryClipboard(conn).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnsupportedTmuxVersionError);
    expect((err as UnsupportedTmuxVersionError).required).toEqual({
      major: 3,
      minor: 3,
    });
    expect(sent.some((c) => c.startsWith("refresh-client -l"))).toBe(false);
  });

  it("proceeds to send refresh-client -l on tmux 3.3", async () => {
    const { conn, sent } = fakeConnection("3.3a");
    await queryClipboard(conn);
    expect(sent.some((c) => c.startsWith("refresh-client -l"))).toBe(true);
  });
});

describe("paneCwd version gate", () => {
  it("rejects below tmux 3.7 with the 3.7 requirement and never reads the path", async () => {
    const { conn, sent } = fakeConnection("3.6b", ["/srv"]);

    const err: unknown = await paneCwd(conn, 4).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnsupportedTmuxVersionError);
    expect((err as UnsupportedTmuxVersionError).required).toEqual({
      major: 3,
      minor: 7,
    });
    expect(sent.some((c) => c.includes("#{pane_current_path}"))).toBe(false);
  });

  it("reads the target pane's path once on tmux 3.7, decoded from latin1", async () => {
    // "/srv/café" as tmux sends it: UTF-8 bytes in a latin1 container.
    const { conn, sent } = fakeConnection("3.7", ["/srv/cafÃ©"]);

    await expect(paneCwd(conn, 4)).resolves.toBe("/srv/café");
    expect(sent.filter((c) => c.includes("#{pane_current_path}"))).toEqual([
      'display-message -p -t %4 "#{pane_current_path}"',
    ]);
  });

  it("drops CRLF residue from the path", async () => {
    const { conn } = fakeConnection("3.7", ["/srv\r"]);
    await expect(paneCwd(conn, 4)).resolves.toBe("/srv");
  });

  it("rejects tmux's empty can't-read-cwd reply as PaneCwdUnavailableError", async () => {
    const { conn } = fakeConnection("3.7", [""]);
    await expect(paneCwd(conn, 4)).rejects.toThrow(PaneCwdUnavailableError);
  });

  it.each([[[]], [["/a", "b"]]])(
    "treats a reply of %j as a reply-shape error, not a path",
    async (reply) => {
      const { conn } = fakeConnection("3.8", reply);
      await expect(paneCwd(conn, 1)).rejects.toThrow(TmuxReplyFormatError);
    },
  );
});
