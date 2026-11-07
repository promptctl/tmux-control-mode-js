// tests/unit/errors.test.ts
import { describe, it, expect } from "vitest";
import { TmuxCommandError } from "../../src/errors.js";
import type { CommandResponse } from "../../src/protocol/types.js";

function errorResponse(output: string[]): CommandResponse {
  return { commandNumber: 1, timestamp: 0, output, success: false };
}

describe("TmuxCommandError — headline selection", () => {
  it("uses the first non-empty output line", () => {
    const err = new TmuxCommandError(
      errorResponse(["", "unknown command: foo"]),
    );
    expect(err.message).toBe("unknown command: foo");
  });

  it("falls back to a generic message when output is empty", () => {
    const err = new TmuxCommandError(errorResponse([]));
    expect(err.message).toBe("tmux command failed (%error)");
  });

  // Regression: a response-block line may carry a trailing \r
  // (TmuxParser.feed() no longer strips it there, for capture-pane byte
  // fidelity). A line that is only "\r" has length 1, so the old
  // `line.length > 0` check picked it as the headline — an invisible \r
  // as the thrown error's message — instead of skipping it as blank.
  it("treats a lone trailing-\\r line as blank, not as the headline", () => {
    const err = new TmuxCommandError(errorResponse(["\r", "real diagnostic"]));
    expect(err.message).toBe("real diagnostic");
  });

  it("strips a trailing \\r off the headline it does pick", () => {
    const err = new TmuxCommandError(errorResponse(["real diagnostic\r"]));
    expect(err.message).toBe("real diagnostic");
  });

  // Regression: a doubled-up CRLF transport can leave a run of \r's, not
  // just one (parser.ts's processLine() already tolerates an arbitrary
  // run). A single-\r strip would turn "\r\r" into "\r" — still non-empty —
  // and pick it as the headline instead of skipping it as blank.
  it("treats a doubled \\r\\r line as blank too", () => {
    const err = new TmuxCommandError(
      errorResponse(["\r\r", "real diagnostic"]),
    );
    expect(err.message).toBe("real diagnostic");
  });
});
