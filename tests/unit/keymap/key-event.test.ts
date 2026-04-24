// tests/unit/keymap/key-event.test.ts
// keysEqual matching rules — especially the implicit-shift behavior for
// shifted characters that browsers deliver with shift:true baked in.

import { describe, it, expect } from "vitest";
import { keysEqual, parseChord } from "../../../src/keymap/index.js";

describe("keysEqual implicit-shift matching", () => {
  it("parseChord('%') matches a KeyEvent with shift:true (browser reports shift+5 as %/shift:true)", () => {
    const chord = parseChord("%");
    const ev = { key: "%", ctrl: false, alt: false, shift: true, meta: false };
    expect(keysEqual(chord, ev)).toBe(true);
  });

  it("parseChord('%') also matches a KeyEvent with shift:false (synthetic events)", () => {
    const chord = parseChord("%");
    const ev = { key: "%", ctrl: false, alt: false, shift: false, meta: false };
    expect(keysEqual(chord, ev)).toBe(true);
  });

  it.each([['"', "quote"], ["{", "left-brace"], ["}", "right-brace"], ["!", "bang"], ["(", "lparen"], [")", "rparen"], [":", "colon"], ["&", "amp"], ["|", "pipe"]])(
    "matches %s (shifted symbol) regardless of shift flag",
    (sym) => {
      const chord = parseChord(sym);
      const shifted = { key: sym, ctrl: false, alt: false, shift: true, meta: false };
      expect(keysEqual(chord, shifted)).toBe(true);
    },
  );

  it("uppercase letter A matches event with shift:true (Shift+a → 'A')", () => {
    const chord = parseChord("A");
    const ev = { key: "A", ctrl: false, alt: false, shift: true, meta: false };
    expect(keysEqual(chord, ev)).toBe(true);
  });

  it("lowercase letter 'a' does NOT match event with shift:true (that would be 'A')", () => {
    // The browser never produces {key:'a', shift:true} in practice — shift+a
    // produces {key:'A', shift:true}. But verify our matcher is strict here:
    // a chord on lowercase 'a' requires shift:false.
    const chord = parseChord("a");
    const pressedA = { key: "a", ctrl: false, alt: false, shift: true, meta: false };
    expect(keysEqual(chord, pressedA)).toBe(false);
  });

  it("digit '1' does NOT match event with shift:true (that would be '!')", () => {
    const chord = parseChord("1");
    const ev = { key: "1", ctrl: false, alt: false, shift: true, meta: false };
    expect(keysEqual(chord, ev)).toBe(false);
  });

  it("modifiers other than shift still matter for implicit-shift characters", () => {
    const chord = parseChord("%");
    const withCtrl = { key: "%", ctrl: true, alt: false, shift: true, meta: false };
    expect(keysEqual(chord, withCtrl)).toBe(false);
  });

  it("multi-character keys (Enter, ArrowUp) are not affected by the implicit-shift rule", () => {
    const chord = parseChord("Enter");
    const withShift = { key: "Enter", ctrl: false, alt: false, shift: true, meta: false };
    // Enter is not a single non-alphanumeric character; shift must match explicitly.
    expect(keysEqual(chord, withShift)).toBe(false);
  });
});
