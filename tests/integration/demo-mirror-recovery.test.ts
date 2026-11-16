// tests/integration/demo-mirror-recovery.test.ts
//
// The demo's mirror registry lives as long as the bridge, and tmux may restart
// under it. When tmux dies, every viewer is told the stream is over and is
// closed; once tmux is back, the next viewer is served over a fresh control
// client, with no bridge restart. Gated behind TMUX_INTEGRATION=1.
//
// The registry reads the package's built dist/ as the demo does: run
// `pnpm run build` first.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import { tmux, uniqueSocket } from "../helpers/integration.js";
import {
  MirrorRegistry,
  type MirrorViewer,
} from "../../examples/web-multiplexer/server/mirror-registry.js";
import type { MirrorControlFrame } from "../../examples/web-multiplexer/shared/mirror-frame.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

function recordingViewer(): {
  viewer: MirrorViewer;
  frames: MirrorControlFrame[];
  closed: () => boolean;
} {
  const frames: MirrorControlFrame[] = [];
  let closed = false;
  return {
    frames,
    closed: () => closed,
    viewer: {
      sendControl: (frame) => frames.push(frame),
      sendBytes: () => undefined,
      close: () => {
        closed = true;
      },
    },
  };
}

describe.skipIf(!RUN_INTEGRATION)("demo mirror across a tmux restart", () => {
  const socket = uniqueSocket("tmux-bridge-test-", "mirror-recovery");
  let registry: MirrorRegistry;

  /** Start tmux on the socket; resolve the new pane's number. */
  const startTmux = (): number => {
    tmux(socket, ["new-session", "-d", "-x", "80", "-y", "24"]);
    return Number(
      tmux(socket, ["display-message", "-p", "#{pane_id}"]).trim().slice(1),
    );
  };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The registry's control client attaches where the demo's does.
    process.env.TMUX_DEMO_SOCKET = socket;
    registry = new MirrorRegistry();
  });

  afterAll(() => {
    registry.close();
    delete process.env.TMUX_DEMO_SOCKET;
    killTmuxServer(socket);
    vi.restoreAllMocks();
  });

  it("ends the mirror when tmux dies and serves the next viewer once it is back", async () => {
    const first = recordingViewer();
    await registry.addViewer(startTmux(), first.viewer);
    expect(first.frames[0]).toMatchObject({ kind: "size", cols: 80 });

    killTmuxServer(socket);
    await vi.waitFor(() => expect(first.closed()).toBe(true), {
      timeout: 5000,
    });
    expect(first.frames.at(-1)).toEqual({
      kind: "error",
      message: "tmux connection lost",
    });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[mirror\] tmux connection ended/),
    );

    const second = recordingViewer();
    await registry.addViewer(startTmux(), second.viewer);
    expect(second.frames[0]).toMatchObject({ kind: "size", cols: 80 });
    expect(second.closed()).toBe(false);
  });
});
