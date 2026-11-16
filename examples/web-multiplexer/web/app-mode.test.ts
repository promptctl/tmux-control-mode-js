// examples/web-multiplexer/web/app-mode.test.ts
//
// `parseAppMode` names a mode for every row of the table and for nothing
// else — including names an object lookup would find on its prototype.

import { describe, it, expect } from "vitest";
import { APP_MODES, parseAppMode } from "./app-mode.ts";

describe("parseAppMode", () => {
  it.each(APP_MODES.map((m) => m.value))("parses %s", (value) => {
    expect(parseAppMode(value)).toBe(value);
  });

  it.each(["", "Multiplexer", "toString", "__proto__", "nonsense"])(
    "returns null for %o",
    (value) => {
      expect(parseAppMode(value)).toBeNull();
    },
  );
});
