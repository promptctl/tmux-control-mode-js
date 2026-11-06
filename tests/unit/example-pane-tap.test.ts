// tests/unit/example-pane-tap.test.ts
//
// A tap that cannot stand up (mkfifo fails) must throw synchronously and
// never fire `onReadError`: its owners (MirrorRegistry's hub, the firehose's
// tap map) are mid-construction when the call returns, so a callback there
// ran against a half-built owner — a TDZ crash in MirrorRegistry.ensureHub and
// a dead tap registered in the firehose map.

import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tapPaneToFifo } from "../../examples/web-multiplexer/server/pane-tap.js";

describe("tapPaneToFifo stand-up failure", () => {
  it("throws without calling onReadError or running tmux", () => {
    const execute = vi.fn();
    const onReadError = vi.fn();
    const missingDir = join(tmpdir(), `pane-tap-missing-${process.pid}`, "x");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() =>
      tapPaneToFifo(execute, missingDir, 7, () => undefined, { onReadError }),
    ).toThrow();
    expect(onReadError).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
