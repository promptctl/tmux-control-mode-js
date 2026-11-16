// tests/unit/example-detached-commands.test.ts
//
// The demo server fires some tmux commands and forgets them: a collaborator's
// keystrokes, a mirror viewer's join. Node ends the process on an unhandled
// rejection, so each owner's entry point must settle however its connection
// ends. Closing the owner with a command in flight is quiet; tmux going away
// under a live owner is warned.
//
// A real TmuxClient runs over a transport that never replies, so a command
// stays in flight until the transport ends.

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
import type { ReadyControlClient } from "../../examples/web-multiplexer/server/control-client.js";
import type { MirrorControlFrame } from "../../examples/web-multiplexer/shared/mirror-frame.js";

/** A transport tmux never answers on; it ends when closed or when tmux "exits". */
class SilentTransport implements TmuxTransport {
  readonly sent: string[] = [];
  private closeCb: ((reason?: string) => void) | undefined;
  private ended = false;

  send(command: string): SendResult {
    this.sent.push(command);
    return { ok: true };
  }
  onData(): void {}
  onClose(callback: (reason?: string) => void): void {
    this.closeCb = callback;
  }
  close(): void {
    this.end(undefined);
  }
  /** The transport ends — `undefined` for a local close, a reason for tmux's exit. */
  end(reason: string | undefined): void {
    if (this.ended) return;
    this.ended = true;
    this.closeCb?.(reason);
  }
}

function silentClient(): {
  transport: SilentTransport;
  spawn: () => ReadyControlClient;
} {
  const transport = new SilentTransport();
  const client = new TmuxClient(transport);
  return {
    transport,
    spawn: () => ({ client, ready: Promise.resolve() }),
  };
}

/** Wait until a command has gone out on the transport. */
async function inFlight(transport: SilentTransport): Promise<void> {
  await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThan(0));
}

function recordingViewer(): {
  viewer: MirrorViewer;
  frames: MirrorControlFrame[];
} {
  const frames: MirrorControlFrame[] = [];
  return {
    frames,
    viewer: {
      sendControl: (frame) => frames.push(frame),
      sendBytes: () => undefined,
      close: () => undefined,
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
    const { transport, spawn } = silentClient();
    const input = new CollabInput(spawn);
    const sent = input.sendKeyBytes(3, new Uint8Array([0x61]));
    await inFlight(transport);
    input.close();
    await sent;
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns when tmux goes away with the send in flight", async () => {
    const { transport, spawn } = silentClient();
    const input = new CollabInput(spawn);
    const sent = input.sendKeyBytes(3, new Uint8Array([0x61]));
    await inFlight(transport);
    transport.end("server exited");
    await sent;
    expect(console.warn).toHaveBeenCalledWith(
      "[collab] sendKeyBytes to %3 failed: transport closed before command completed: server exited",
    );
    input.close();
  });
});

describe("MirrorRegistry.addViewer never rejects", () => {
  it("refuses the viewer quietly when the registry closes mid-seed", async () => {
    const { transport, spawn } = silentClient();
    const registry = new MirrorRegistry(spawn);
    const { viewer, frames } = recordingViewer();
    const joined = registry.addViewer(3, viewer);
    await inFlight(transport);
    registry.close();
    const dispose = await joined;
    dispose();
    expect(frames).toEqual([
      { kind: "error", message: "bridge is shutting down" },
    ]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("refuses the viewer and warns when tmux goes away mid-seed", async () => {
    const { transport, spawn } = silentClient();
    const registry = new MirrorRegistry(spawn);
    const { viewer, frames } = recordingViewer();
    const joined = registry.addViewer(3, viewer);
    await inFlight(transport);
    transport.end("server exited");
    await joined;
    expect(frames).toEqual([{ kind: "error", message: "mirror of %3 failed" }]);
    expect(console.warn).toHaveBeenCalledWith(
      "[mirror] join of %3 failed: transport closed before command completed: server exited",
    );
    registry.close();
  });
});
