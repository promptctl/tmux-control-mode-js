// tests/unit/transport.test.ts
// Unit tests for the DCS introducer stripper used in -CC mode,
// and for the spawnTmux fail-fast guard against controlControl misuse.

import { createDcsStripper, spawnTmux } from "../../src/transport/spawn.js";

const INTRO = "\u001bP1000p";

describe("createDcsStripper", () => {
  it("strips a fully-formed introducer followed by data in one chunk", () => {
    const strip = createDcsStripper();
    const r = strip(INTRO + "%begin 1 2 1\n");
    expect(r.forward).toBe("%begin 1 2 1\n");
    expect(r.error).toBeUndefined();
  });

  it("forwards subsequent chunks unchanged after the introducer is consumed", () => {
    const strip = createDcsStripper();
    strip(INTRO);
    const r = strip("%output %1 hello\n");
    expect(r.forward).toBe("%output %1 hello\n");
  });

  it("buffers a fragmented introducer split across two chunks", () => {
    const strip = createDcsStripper();
    const r1 = strip("\u001bP10");
    expect(r1.forward).toBe("");
    expect(r1.error).toBeUndefined();
    const r2 = strip("00p%out");
    expect(r2.forward).toBe("%out");
  });

  it("handles the introducer arriving byte-by-byte", () => {
    const strip = createDcsStripper();
    const bytes = INTRO.split("");
    for (let i = 0; i < bytes.length; i++) {
      const r = strip(bytes[i]);
      expect(r.forward).toBe("");
      expect(r.error).toBeUndefined();
    }
    const r = strip("first-data");
    expect(r.forward).toBe("first-data");
  });

  it("rejects an invalid introducer with an error", () => {
    const strip = createDcsStripper();
    const r = strip("\u001bP9999X");
    expect(r.forward).toBe("");
    expect(r.error).toBe("invalid DCS introducer in -CC mode");
  });

  it("returns empty forwards on subsequent chunks after rejection", () => {
    const strip = createDcsStripper();
    strip("\u001bPbogus_");
    const r = strip("%begin");
    expect(r.forward).toBe("");
    expect(r.error).toBeUndefined();
  });

  it("forwards an empty trailing chunk as empty (no spurious data)", () => {
    const strip = createDcsStripper();
    strip(INTRO);
    const r = strip("");
    expect(r.forward).toBe("");
  });

  it("handles introducer immediately followed by an empty remainder", () => {
    const strip = createDcsStripper();
    const r = strip(INTRO);
    expect(r.forward).toBe("");
    expect(r.error).toBeUndefined();
    const r2 = strip("data");
    expect(r2.forward).toBe("data");
  });
});

describe("spawnTmux controlControl guard", () => {
  it("throws clearly when controlControl: true is requested (PTY required)", () => {
    expect(() => spawnTmux([], { controlControl: true })).toThrow(
      /controlControl \(-CC\) mode requires PTY-backed stdio/,
    );
  });

  it("error message points to SPEC.md §12 for rationale", () => {
    expect(() => spawnTmux([], { controlControl: true })).toThrow(
      /SPEC\.md §12/,
    );
  });

  // Note: the "default path doesn't throw" case is exercised by every
  // integration test in tests/integration/client.test.ts — they all spawn
  // -C mode, which would fail if the guard mis-fired.
});
