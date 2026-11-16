// tests/unit/example-detached-commands.test.ts
//
// The demo server fires some tmux commands and forgets them: a collaborator's
// keystrokes, a mirror viewer's join. Node ends the process on an unhandled
// rejection, so each owner's entry point must settle however its connection
// ends. A lost connection is warned once, by the owner of that connection, and
// the next command reaches tmux over a fresh client.
//
// A real TmuxClient runs over a transport that never replies to a command, so
// a command stays in flight until the transport ends.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The demo resolves the package to dist/; its client must come from there too.
import {
  TmuxClient,
  type TmuxTransport,
  type SendResult,
} from "@promptctl/tmux-control-mode-js";
import { CollabInput } from "../../examples/web-multiplexer/server/collab-input.js";
import {
  MirrorRegistry,
  type MirrorViewer,
} from "../../examples/web-multiplexer/server/mirror-registry.js";
import type { MirrorControlFrame } from "../../examples/web-multiplexer/shared/mirror-frame.js";

/** A transport tmux never answers commands on; it ends when closed or when tmux "exits". */
class SilentTransport implements TmuxTransport {
  readonly sent: string[] = [];
  private dataCb: ((chunk: string) => void) | undefined;
  private closeCb: ((reason?: string) => void) | undefined;
  private ended = false;

  send(command: string): SendResult {
    this.sent.push(command);
    return { ok: true };
  }
  onData(callback: (chunk: string) => void): void {
    this.dataCb = callback;
  }
  onClose(callback: (reason?: string) => void): void {
    this.closeCb = callback;
  }
  close(): void {
    this.end(undefined);
  }
  /** tmux answers the command it was started with, so the client is ready. */
  attach(): void {
    this.dataCb?.("%begin 1 1 0\n%end 1 1 0\n");
  }
  /** The transport ends — `undefined` for a local close, a reason for tmux's exit. */
  end(reason: string | undefined): void {
    if (this.ended) return;
    this.ended = true;
    this.closeCb?.(reason);
  }
}

/** Each spawn is a fresh client over a fresh transport; `attached` ones reach ready. */
function silentTmux(attached = true): {
  transports: SilentTransport[];
  spawn: () => TmuxClient;
} {
  const transports: SilentTransport[] = [];
  return {
    transports,
    spawn: () => {
      const transport = new SilentTransport();
      transports.push(transport);
      const client = new TmuxClient(transport);
      if (attached) queueMicrotask(() => transport.attach());
      return client;
    },
  };
}

/** Wait until a command has gone out on the latest transport. */
async function inFlight(
  transports: SilentTransport[],
): Promise<SilentTransport> {
  await vi.waitFor(() =>
    expect(transports.at(-1)?.sent.length ?? 0).toBeGreaterThan(0),
  );
  return transports.at(-1)!;
}

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

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("CollabInput.sendKeyBytes never rejects", () => {
  it("settles quietly when the input is closed with the send in flight", async () => {
    const { transports, spawn } = silentTmux();
    const input = new CollabInput(spawn);
    const sent = input.sendKeyBytes(3, new Uint8Array([0x61]));
    await inFlight(transports);
    input.close();
    await sent;
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns once when tmux goes away, and sends the next keystroke over a fresh client", async () => {
    const { transports, spawn } = silentTmux();
    const input = new CollabInput(spawn);
    const sent = input.sendKeyBytes(3, new Uint8Array([0x61]));
    (await inFlight(transports)).end("server exited");
    await sent;
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["[collab] tmux connection ended: server exited"],
    ]);

    void input.sendKeyBytes(3, new Uint8Array([0x62]));
    await inFlight(transports);
    expect(transports).toHaveLength(2);
    input.close();
  });

  it("settles when the connection ends before it is ready", async () => {
    const { transports, spawn } = silentTmux(false);
    const input = new CollabInput(spawn);
    const sent = input.sendKeyBytes(3, new Uint8Array([0x61]));
    transports[0].end("no server running");
    await sent;
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["[collab] tmux connection ended: no server running"],
    ]);
    input.close();
  });
});

describe("MirrorRegistry.addViewer never rejects", () => {
  it("refuses and closes the viewer quietly when the registry closes mid-seed", async () => {
    const { transports, spawn } = silentTmux();
    const registry = new MirrorRegistry(spawn);
    const { viewer, frames, closed } = recordingViewer();
    const joined = registry.addViewer(3, viewer);
    await inFlight(transports);
    registry.close();
    const dispose = await joined;
    dispose();
    expect(frames).toEqual([
      { kind: "error", message: "bridge is shutting down" },
    ]);
    expect(closed()).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("refuses and closes the viewer, warning once, when tmux goes away mid-seed", async () => {
    const { transports, spawn } = silentTmux();
    const registry = new MirrorRegistry(spawn);
    const { viewer, frames, closed } = recordingViewer();
    const joined = registry.addViewer(3, viewer);
    (await inFlight(transports)).end("server exited");
    await joined;
    expect(frames).toEqual([{ kind: "error", message: "mirror of %3 failed" }]);
    expect(closed()).toBe(true);
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["[mirror] tmux connection ended: server exited"],
    ]);
    registry.close();
  });

  it("refuses the viewer when the connection ends before it is ready", async () => {
    const { transports, spawn } = silentTmux(false);
    const registry = new MirrorRegistry(spawn);
    const { viewer, frames, closed } = recordingViewer();
    const joined = registry.addViewer(3, viewer);
    transports[0].end("no server running");
    await joined;
    expect(frames).toEqual([{ kind: "error", message: "mirror of %3 failed" }]);
    expect(closed()).toBe(true);
    registry.close();
  });
});
