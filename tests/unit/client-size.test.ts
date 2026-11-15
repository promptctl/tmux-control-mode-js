// tests/unit/client-size.test.ts
// ClientSizeClaims: tmux holds the latest live claim's size, and a claim
// released takes only its own sizes with it. The encoders are the oracle for
// each command, so these assert which sizes were sent, not their spelling.

import { describe, expect, it } from "vitest";

import { ClientSizeClaims } from "../../src/client-size.js";
import { TmuxInvalidCommandError } from "../../src/errors.js";
import {
  refreshClientClearFlags,
  refreshClientClearWindowSize,
  refreshClientSetFlags,
  refreshClientSize,
  refreshClientWindowSize,
} from "../../src/protocol/encoder.js";
import type { CommandResponse } from "../../src/protocol/types.js";

const ok: CommandResponse = {
  commandNumber: 0,
  timestamp: 0,
  output: [],
  success: true,
};

function setup({ ignoreSize = false } = {}) {
  const sent: string[] = [];
  const claims = new ClientSizeClaims((command) => {
    sent.push(command);
    return Promise.resolve(ok);
  }, ignoreSize);
  return { claims, take: () => sent.splice(0) };
}

const INTO_SIZING = refreshClientClearFlags(["ignore-size"]);
const OUT_OF_SIZING = refreshClientSetFlags(["ignore-size"]);

describe("ClientSizeClaims", () => {
  it("the first declaration puts the client into window sizing", async () => {
    const { claims, take } = setup();
    await claims.claim().setSize(100, 30);
    expect(take()).toEqual([INTO_SIZING, refreshClientSize(100, 30)]);
  });

  it("releasing the latest claim sends the next latest claim's sizes", async () => {
    const { claims, take } = setup();
    const a = claims.claim();
    const b = claims.claim();
    await b.setSize(120, 40);
    await b.setWindowSize(3, 120, 40);
    await a.setSize(100, 30);
    await a.setWindowSize(3, 100, 30);
    take();
    await a.release();
    expect(take()).toEqual([
      refreshClientSize(120, 40),
      refreshClientWindowSize(3, 120, 40),
    ]);
  });

  it("releasing an earlier claim sends nothing: tmux holds the latest", async () => {
    const { claims, take } = setup();
    const a = claims.claim();
    await a.setWindowSize(3, 100, 30);
    await claims.claim().setWindowSize(3, 120, 40);
    take();
    await a.release();
    expect(take()).toEqual([]);
  });

  // tmux recomputes window sizes on a size command, never on a flag change.
  it("releasing the last claim takes the client out of sizing, then sends sizes so tmux applies it", async () => {
    const { claims, take } = setup();
    const a = claims.claim();
    await a.setSize(100, 30);
    await a.setWindowSize(3, 100, 30);
    await a.setWindowSize(5, 90, 20);
    take();
    await a.release();
    expect(take()).toEqual([
      OUT_OF_SIZING,
      refreshClientClearWindowSize(3),
      refreshClientClearWindowSize(5),
      refreshClientSize(100, 30),
    ]);
  });

  it("releasing a last claim that set only the overall size sends it again after the flag", async () => {
    const { claims, take } = setup();
    const a = claims.claim();
    await a.setSize(100, 30);
    take();
    await a.release();
    expect(take()).toEqual([OUT_OF_SIZING, refreshClientSize(100, 30)]);
  });

  it("a clear leaves the window at another claim's size", async () => {
    const { claims, take } = setup();
    await claims.claim().setWindowSize(3, 100, 30);
    const b = claims.claim();
    await b.setWindowSize(3, 120, 40);
    take();
    await b.clearWindowSize(3);
    expect(take()).toEqual([refreshClientWindowSize(3, 100, 30)]);
  });

  it("an overall size keeps the client in sizing after its windows clear", async () => {
    const { claims, take } = setup();
    const a = claims.claim();
    await a.setSize(100, 30);
    await a.setWindowSize(3, 100, 30);
    take();
    await a.clearWindowSize(3);
    expect(take()).toEqual([refreshClientClearWindowSize(3)]);
  });

  it("declaring what the claims already ask of tmux sends nothing", async () => {
    const { claims, take } = setup();
    const a = claims.claim();
    await a.setWindowSize(3, 100, 30);
    take();
    await a.setWindowSize(3, 100, 30);
    expect(take()).toEqual([]);
  });

  it.each([
    [0, 30],
    [100, 0],
    [10001, 30],
    [100, 10001],
    [100.5, 30],
  ])(
    "a size tmux would refuse (%s x %s) rejects, sends nothing, and leaves the claim's earlier size",
    async (width, height) => {
      const { claims, take } = setup();
      const a = claims.claim();
      await a.setSize(100, 30);
      await a.setWindowSize(3, 100, 30);
      take();
      await expect(a.setSize(width, height)).rejects.toThrow(
        TmuxInvalidCommandError,
      );
      await expect(a.setWindowSize(3, width, height)).rejects.toThrow(
        TmuxInvalidCommandError,
      );
      expect(take()).toEqual([]);
      // The claim still holds 100x30, so a newer claim's release sends it.
      const b = claims.claim();
      await b.setWindowSize(3, 120, 40);
      take();
      await b.release();
      expect(take()).toEqual([refreshClientWindowSize(3, 100, 30)]);
    },
  );

  it.each([-1, 1.5, Number.NaN])(
    "a window id tmux would refuse (%s) rejects and sends nothing",
    async (windowId) => {
      const { claims, take } = setup();
      await expect(
        claims.claim().setWindowSize(windowId, 100, 30),
      ).rejects.toThrow(TmuxInvalidCommandError);
      expect(take()).toEqual([]);
    },
  );

  it("a released claim refuses to declare, and sends nothing", async () => {
    const { claims, take } = setup();
    const a = claims.claim();
    await a.setWindowSize(3, 100, 30);
    await a.release();
    take();
    await expect(a.setWindowSize(3, 100, 30)).rejects.toThrow(
      "the size claim was released",
    );
    await expect(a.setSize(100, 30)).rejects.toThrow(
      "the size claim was released",
    );
    expect(take()).toEqual([]);
  });

  it("a client spawned with ignore-size never leaves it", async () => {
    const { claims, take } = setup({ ignoreSize: true });
    const a = claims.claim();
    await a.setSize(100, 30);
    await a.setWindowSize(3, 100, 30);
    await a.release();
    await claims.claim().setSize(90, 20);
    expect(take()).toEqual([
      refreshClientSize(100, 30),
      refreshClientWindowSize(3, 100, 30),
      refreshClientClearWindowSize(3),
      refreshClientSize(90, 20),
    ]);
  });
});
