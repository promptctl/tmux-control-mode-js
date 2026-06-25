// examples/web-multiplexer/web/mirror-viewer-bridge.ts
// The PROJECTION side of the pane mirror: a read-only transport over the
// `/mirror` WebSocket.
//
// [LAW:types-are-the-program] This class is the read-only contract made
//   concrete. It has `onBytes` (inbound pane bytes), observable lifecycle
//   state, and connect/disconnect — and NO `execute` / `sendKeys` / `send` of
//   any kind. A consumer holding a `MirrorViewerBridge` *cannot* write to the
//   pane, because the capability is absent from the type. Contrast `TmuxBridge`
//   (./bridge.ts), which has the write methods; the viewer is a deliberately
//   smaller surface, not the same surface with a flag flipped.
// [LAW:dataflow-not-control-flow] The frame's runtime type is the channel
//   discriminator: ArrayBuffer → pane bytes (seed then live, written to the
//   sink unchanged); string → a JSON `MirrorControlFrame` (lifecycle). The same
//   split ws-client.ts uses for the main bridge.

import { makeAutoObservable, runInAction } from "mobx";
import {
  mirrorSocketUrl,
  type MirrorControlFrame,
} from "../shared/mirror-frame.ts";

/**
 * Lifecycle of a mirror viewer connection.
 *   - `connecting` — dialing / awaiting the first frame
 *   - `live`       — receiving pane bytes; `viewers`/`cols`/`rows` are current
 *   - `gone`       — the mirrored pane closed (terminal)
 *   - `error`      — could not establish the mirror (`message` says why)
 *   - `closed`     — the socket dropped before reaching a terminal state
 */
export type MirrorStatus = "connecting" | "live" | "gone" | "error" | "closed";

export class MirrorViewerBridge {
  status: MirrorStatus = "connecting";
  /** Browsers currently watching this pane (including this one). */
  viewers = 0;
  /** Pane geometry from the server; `0` until the first `size` frame. */
  cols = 0;
  rows = 0;
  errorMessage: string | null = null;

  private ws: WebSocket | null = null;
  private readonly byteHandlers = new Set<(data: Uint8Array) => void>();

  constructor(
    private readonly wsBase: string,
    readonly paneId: number,
  ) {
    makeAutoObservable<this, "ws" | "byteHandlers" | "wsBase">(this, {
      ws: false,
      byteHandlers: false,
      wsBase: false,
    });
  }

  /**
   * Subscribe to pane bytes (seed frame first, then live output). Returns an
   * unsubscribe. Attach BEFORE `connect()` so the seed is never missed — the
   * bridge does no buffering of its own.
   */
  onBytes(handler: (data: Uint8Array) => void): () => void {
    this.byteHandlers.add(handler);
    return () => this.byteHandlers.delete(handler);
  }

  /** Dial the `/mirror` socket. Idempotent: a second call while live is a no-op. */
  connect(): void {
    if (this.ws !== null) return;
    const ws = new WebSocket(mirrorSocketUrl(this.wsBase, this.paneId));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      if (ev.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(ev.data);
        this.byteHandlers.forEach((h) => h(bytes));
      } else {
        this.handleControl(ev.data as string);
      }
    });
    ws.addEventListener("close", () =>
      runInAction(() => {
        if (this.ws !== ws) return;
        this.ws = null;
        // A socket drop is only `closed` if we hadn't already reached a terminal
        // state — never overwrite a `gone`/`error` the server told us about.
        if (this.status === "connecting" || this.status === "live") {
          this.status = "closed";
        }
      }),
    );
  }

  /** Close the socket. Read-only means this is the ONLY thing a viewer can do. */
  disconnect(): void {
    if (this.ws !== null) {
      const ws = this.ws;
      this.ws = null;
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
    }
  }

  private handleControl(raw: string): void {
    let frame: MirrorControlFrame;
    try {
      frame = JSON.parse(raw) as MirrorControlFrame;
    } catch (err) {
      // [LAW:no-silent-failure] A malformed control frame is a protocol
      // violation (the server only ever sends JSON.stringify'd frames), not
      // something to swallow. The viewer has no separate error channel, so its
      // status IS the surface — make the break visible in the UI, and log the
      // offending frame for the developer console.
      console.warn("[mirror] malformed control frame:", raw, err);
      runInAction(() => {
        this.status = "error";
        this.errorMessage = "malformed control frame from bridge";
      });
      return;
    }
    runInAction(() => {
      if (frame.kind === "size") {
        this.cols = frame.cols;
        this.rows = frame.rows;
        if (this.status === "connecting") this.status = "live";
      } else if (frame.kind === "viewers") {
        this.viewers = frame.count;
        if (this.status === "connecting") this.status = "live";
      } else if (frame.kind === "gone") {
        this.status = "gone";
      } else {
        this.status = "error";
        this.errorMessage = frame.message;
      }
    });
  }
}
