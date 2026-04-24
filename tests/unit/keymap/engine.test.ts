// tests/unit/keymap/engine.test.ts
// Pure engine tests — no tmux, no client, no transport.

import { describe, it, expect } from "vitest";
import {
  handleKey,
  INITIAL_STATE,
  defaultTmuxKeymap,
  parseChord,
  type KeyEvent,
} from "../../../src/keymap/index.js";

const keymap = defaultTmuxKeymap();

function ev(chord: string): KeyEvent {
  return parseChord(chord);
}

describe("handleKey — root mode", () => {
  it("prefix enters prefix mode, no actions, handled", () => {
    const r = handleKey(ev("C-b"), INITIAL_STATE, keymap);
    expect(r.state).toEqual({ mode: "prefix" });
    expect(r.actions).toEqual([]);
    expect(r.handled).toBe(true);
  });

  it("non-prefix key passes through, not handled", () => {
    const r = handleKey(ev("a"), INITIAL_STATE, keymap);
    expect(r.state).toEqual({ mode: "root" });
    expect(r.actions).toEqual([]);
    expect(r.handled).toBe(false);
  });

  it("bound chord in root mode without prefix does NOT fire (bindings are prefix-only)", () => {
    // `c` alone is not a prefix-less binding — it requires C-b first.
    const r = handleKey(ev("c"), INITIAL_STATE, keymap);
    expect(r.actions).toEqual([]);
    expect(r.handled).toBe(false);
  });
});

describe("handleKey — prefix mode", () => {
  const PREFIX: ReturnType<typeof handleKey>["state"] = { mode: "prefix" };

  it("bound chord fires action and returns to root", () => {
    const r = handleKey(ev("c"), PREFIX, keymap);
    expect(r.state).toEqual({ mode: "root" });
    expect(r.actions).toEqual([{ type: "new-window" }]);
    expect(r.handled).toBe(true);
  });

  it("unbound chord is swallowed silently and returns to root", () => {
    const r = handleKey(ev("Q"), PREFIX, keymap);
    expect(r.state).toEqual({ mode: "root" });
    expect(r.actions).toEqual([]);
    expect(r.handled).toBe(true);
  });

  it("digit chord maps to select-window with index", () => {
    const r = handleKey(ev("3"), PREFIX, keymap);
    expect(r.actions).toEqual([{ type: "select-window", index: 3 }]);
  });

  it("% maps to horizontal split, \" maps to vertical split", () => {
    expect(handleKey(ev("%"), PREFIX, keymap).actions).toEqual([
      { type: "split", orientation: "horizontal" },
    ]);
    expect(handleKey(ev('"'), PREFIX, keymap).actions).toEqual([
      { type: "split", orientation: "vertical" },
    ]);
  });

  it("arrow keys map to select-pane by direction", () => {
    expect(handleKey(ev("Up"), PREFIX, keymap).actions).toEqual([
      { type: "select-pane", direction: "up" },
    ]);
    expect(handleKey(ev("Right"), PREFIX, keymap).actions).toEqual([
      { type: "select-pane", direction: "right" },
    ]);
  });

  it("C-arrow maps to resize-pane with default amount", () => {
    expect(handleKey(ev("C-Down"), PREFIX, keymap).actions).toEqual([
      { type: "resize-pane", direction: "down", amount: 5 },
    ]);
  });
});

describe("bare modifier keydowns are ignored", () => {
  const PREFIX: ReturnType<typeof handleKey>["state"] = { mode: "prefix" };

  it("pressing Shift in prefix mode keeps state=prefix, no actions, not handled", () => {
    const shift = { key: "Shift", ctrl: false, alt: false, shift: true, meta: false };
    const r = handleKey(shift, PREFIX, keymap);
    expect(r.state).toEqual({ mode: "prefix" });
    expect(r.actions).toEqual([]);
    expect(r.handled).toBe(false);
  });

  it("Control / Alt / Meta alone don't disturb prefix mode", () => {
    for (const key of ["Control", "Alt", "Meta"]) {
      const ev = { key, ctrl: false, alt: false, shift: false, meta: false };
      const r = handleKey(ev, PREFIX, keymap);
      expect(r.state).toEqual({ mode: "prefix" });
      expect(r.handled).toBe(false);
    }
  });

  it("bare modifier in root mode is also a no-op pass-through", () => {
    const shift = { key: "Shift", ctrl: false, alt: false, shift: true, meta: false };
    const r = handleKey(shift, INITIAL_STATE, keymap);
    expect(r.state).toEqual({ mode: "root" });
    expect(r.actions).toEqual([]);
    expect(r.handled).toBe(false);
  });

  it("full sequence: C-b → Shift → % fires the split action", () => {
    // Simulate a real browser key sequence on US keyboard for `C-b %`:
    //   keydown C-b, keydown Shift (shift:true bare), keydown % (shift:true key="%")
    const cb = { key: "b", ctrl: true, alt: false, shift: false, meta: false };
    const shift = { key: "Shift", ctrl: false, alt: false, shift: true, meta: false };
    const pct = { key: "%", ctrl: false, alt: false, shift: true, meta: false };

    let state: ReturnType<typeof handleKey>["state"] = INITIAL_STATE;
    state = handleKey(cb, state, keymap).state;
    expect(state).toEqual({ mode: "prefix" });
    state = handleKey(shift, state, keymap).state;
    expect(state).toEqual({ mode: "prefix" }); // must survive the Shift keydown
    const r = handleKey(pct, state, keymap);
    expect(r.actions).toEqual([{ type: "split", orientation: "horizontal" }]);
    expect(r.state).toEqual({ mode: "root" });
  });
});

describe("full prefix sequence", () => {
  it("C-b then c ends with new-window action and root state", () => {
    const step1 = handleKey(ev("C-b"), INITIAL_STATE, keymap);
    const step2 = handleKey(ev("c"), step1.state, keymap);
    expect(step1.actions).toEqual([]);
    expect(step2.actions).toEqual([{ type: "new-window" }]);
    expect(step2.state).toEqual({ mode: "root" });
  });

  it("C-b then unbound key returns to root with no action", () => {
    const step1 = handleKey(ev("C-b"), INITIAL_STATE, keymap);
    const step2 = handleKey(ev("Z"), step1.state, keymap);
    expect(step2.actions).toEqual([]);
    expect(step2.state).toEqual({ mode: "root" });
    expect(step2.handled).toBe(true);
  });
});
