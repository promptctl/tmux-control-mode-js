// tests/unit/request-report-version-gate.test.ts
//
// [LAW:verifiable-goals] The library supports tmux 3.2+, but `requestReport`
// emits `refresh-client -r`, a flag added in tmux 3.5. The single enforcer of
// that floor is the `requestReport` free function: it probes the live tmux
// version over the control-mode connection and rejects with a clear, typed
// precondition error on 3.2-3.4 instead of leaking tmux's raw "unknown flag"
// %error. These tests pin that behavior with a fake connection, so the <3.5
// rejection is verified without owning an old tmux binary.

import { describe, it, expect } from "vitest";
import { requestReport, queryTmuxVersion } from "../../src/commands/index.js";
import { UnsupportedTmuxVersionError } from "../../src/errors.js";
import type { TmuxConnection } from "../../src/client.js";
import type { CommandResponse } from "../../src/protocol/types.js";

// Minimal TmuxConnection fake: records every command string and answers the
// version probe with a configurable version line. Every other command resolves
// to an empty success. on/off/attachBytesSink are unused by the command
// free-functions and are inert here.
function fakeConnection(versionLine: string): {
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
        return Promise.resolve(respond([versionLine]));
      }
      return Promise.resolve(respond([]));
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
    await expect(queryTmuxVersion(conn)).rejects.toThrow(/could not determine/);
  });
});
