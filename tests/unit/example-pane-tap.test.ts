// tests/unit/example-pane-tap.test.ts
//
// tapPaneToFifo owns its failure policy: every way a tap dies reaches the
// owner as ONE `onReadError`, always after the call has returned (so an owner
// mid-construction never sees it), with the FIFO path cleaned up so a retry
// can succeed. PaneFirehose's reaction — re-tap with backoff — is checked here
// too, through a fake `execute`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CommandResponse } from "../../src/protocol/types.js";
import { tapPaneToFifo } from "../../examples/web-multiplexer/server/pane-tap.js";
import { PaneFirehose } from "../../examples/web-multiplexer/server/pane-firehose.js";

function response(success: boolean, output: string[] = []): CommandResponse {
  return { commandNumber: 0, timestamp: 0, output, success };
}

/** Let queued microtasks and already-settled promise chains run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-tap-test-"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("tapPaneToFifo failure policy", () => {
  it("reports a failed mkfifo through onReadError, after returning", async () => {
    const onReadError = vi.fn();
    const execute = vi.fn(() => Promise.resolve(response(true)));
    const missingDir = join(dir, "missing");

    const dispose = tapPaneToFifo(execute, missingDir, 7, () => undefined, {
      onReadError,
    });
    expect(onReadError).not.toHaveBeenCalled();
    await settle();
    expect(onReadError).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("cat >>"));
    dispose();
  });

  it("reports a rejected pipe-pane and removes the FIFO", async () => {
    const onReadError = vi.fn();
    const execute = vi.fn((command: string) =>
      command.includes("cat >>")
        ? Promise.reject(new Error("can't find pane: %7"))
        : Promise.resolve(response(true)),
    );

    tapPaneToFifo(execute, dir, 7, () => undefined, { onReadError });
    expect(statSync(join(dir, "7")).isFIFO()).toBe(true);
    await settle();
    expect(onReadError).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, "7"))).toBe(false);
  });

  it("reports a pipe-pane %error", async () => {
    const onReadError = vi.fn();
    const execute = vi.fn((command: string) =>
      Promise.resolve(response(!command.includes("cat >>"))),
    );

    tapPaneToFifo(execute, dir, 7, () => undefined, { onReadError });
    await settle();
    expect(onReadError).toHaveBeenCalledTimes(1);
  });

  it("replaces a stale path left where the FIFO goes", async () => {
    writeFileSync(join(dir, "7"), "leftover");
    const onReadError = vi.fn();
    const execute = vi.fn(() => Promise.resolve(response(true)));

    const dispose = tapPaneToFifo(execute, dir, 7, () => undefined, {
      onReadError,
    });
    await settle();
    expect(onReadError).not.toHaveBeenCalled();
    expect(statSync(join(dir, "7")).isFIFO()).toBe(true);
    dispose();
  });
});

describe("PaneFirehose tap retry", () => {
  it("re-taps a pane whose tap died, after a backoff", async () => {
    let now = 0;
    const execute = vi.fn((command: string) => {
      if (command.startsWith("list-panes")) {
        return Promise.resolve(response(true, ["%1"]));
      }
      if (command.includes("cat >>")) return Promise.reject(new Error("gone"));
      return Promise.resolve(response(true));
    });
    const pipeAttempts = (): number =>
      execute.mock.calls.filter(([c]) => c.includes("cat >>")).length;

    const firehose = new PaneFirehose(execute, () => undefined, {
      refreshIntervalMs: 5,
      now: () => now,
    });
    try {
      await firehose.start();
      await new Promise((r) => setTimeout(r, 50));
      // Many refresh ticks passed, but the clock has not: no retry yet.
      expect(pipeAttempts()).toBe(1);

      now += 5;
      await new Promise((r) => setTimeout(r, 50));
      expect(pipeAttempts()).toBe(2);

      // The second death doubles the wait: 5ms more is not enough.
      now += 5;
      await new Promise((r) => setTimeout(r, 50));
      expect(pipeAttempts()).toBe(2);
      now += 5;
      await new Promise((r) => setTimeout(r, 50));
      expect(pipeAttempts()).toBe(3);
    } finally {
      firehose.stop();
    }
  });
});
