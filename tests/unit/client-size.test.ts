// tests/unit/client-size.test.ts
// ClientSizeClaims: tmux holds the latest live claim's size, and a claim
// released takes only its own sizes with it. The encoders are the oracle for
// each command, so these assert which sizes were sent, not their spelling.

import { describe, expect, it } from "vitest";

import { ClientSizeClaims } from "../../src/client-size.js";
import { TmuxCommandError } from "../../src/errors.js";
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

function setup(ignoreSize = false) {
  const sent: string[] = [];
  let refused: string | null = null;
  const claims = new ClientSizeClaims((command) => {
    sent.push(command);
    return command === refused
      ? Promise.reject(new TmuxCommandError({ ...ok, success: false }))
      : Promise.resolve(ok);
  }, ignoreSize);
  return {
    claims,
    take: () => sent.splice(0),
    refuse: (command: string) => (refused = command),
  };
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

  it("releasing the last claim clears its windows, then takes the client out of sizing", async () => {
    const { claims, take } = setup();
    const a = claims.claim();
    await a.setSize(100, 30);
    await a.setWindowSize(3, 100, 30);
    await a.setWindowSize(5, 90, 20);
    take();
    await a.release();
    expect(take()).toEqual([
      refreshClientClearWindowSize(3),
      refreshClientClearWindowSize(5),
      OUT_OF_SIZING,
    ]);
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

  it("declaring what tmux already holds sends nothing", async () => {
    const { claims, take } = setup();
    const a = claims.claim();
    await a.setWindowSize(3, 100, 30);
    take();
    await a.setWindowSize(3, 100, 30);
    expect(take()).toEqual([]);
  });

  it("a refused declaration rejects, and tmux is sent the size it held before", async () => {
    const { claims, take, refuse } = setup();
    const a = claims.claim();
    const b = claims.claim();
    await a.setWindowSize(3, 100, 30);
    take();
    refuse(refreshClientWindowSize(3, 120, 40));
    await expect(b.setWindowSize(3, 120, 40)).rejects.toThrow(TmuxCommandError);
    expect(take()).toEqual([
      refreshClientWindowSize(3, 120, 40),
      refreshClientWindowSize(3, 100, 30),
    ]);
    // b holds nothing on the window, so a's release clears it.
    await a.release();
    expect(take()).toEqual([refreshClientClearWindowSize(3), OUT_OF_SIZING]);
  });

  it("a refused size keeps the claim's earlier size, which tmux still holds", async () => {
    const { claims, take, refuse } = setup();
    const a = claims.claim();
    await a.setSize(100, 30);
    take();
    refuse(refreshClientSize(0, 0));
    await expect(a.setSize(0, 0)).rejects.toThrow(TmuxCommandError);
    expect(take()).toEqual([
      refreshClientSize(0, 0),
      refreshClientSize(100, 30),
    ]);
  });

  it("a refused size leaves a newer claim the latest", async () => {
    const { claims, take, refuse } = setup();
    const a = claims.claim();
    const b = claims.claim();
    await a.setWindowSize(3, 100, 30);
    await b.setWindowSize(3, 120, 40);
    take();
    refuse(refreshClientWindowSize(3, 0, 0));
    await expect(a.setWindowSize(3, 0, 0)).rejects.toThrow(TmuxCommandError);
    expect(take()).toEqual([
      refreshClientWindowSize(3, 0, 0),
      refreshClientWindowSize(3, 120, 40),
    ]);
    // a still holds 100x30 behind b, so b's release sends it.
    await b.release();
    expect(take()).toEqual([refreshClientWindowSize(3, 100, 30)]);
  });

  it("a client spawned with ignore-size never leaves it", async () => {
    const { claims, take } = setup(true);
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
