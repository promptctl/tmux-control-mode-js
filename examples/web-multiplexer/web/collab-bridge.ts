// examples/web-multiplexer/web/collab-bridge.ts
// The READ-WRITE transport over the `/collab-ws` WebSocket — the collaborative
// sibling of the read-only `MirrorViewerBridge`.
//
// [LAW:types-are-the-program] This is a DIFFERENT type from the mirror viewer,
//   not the same one with a flag. It has everything the mirror has — `onBytes`
//   (inbound pane bytes), observable lifecycle, connect/disconnect — PLUS one
//   capability the mirror is structurally without: `sendKeys`. A consumer
//   holding a `MirrorViewerBridge` cannot write to the pane because the method
//   does not exist; a consumer holding a `CollabBridge` can, because it does.
//   The read-only guarantee of .14 is never loosened; collaboration is a new,
//   larger surface alongside it.
// [LAW:dataflow-not-control-flow] The frame's runtime type is the channel
//   discriminator: ArrayBuffer → pane bytes (seed then live, written to the
//   sink unchanged); string → a JSON `MirrorControlFrame` (lifecycle). The
//   server→browser shape is the mirror's verbatim; only the browser→server
//   `keys` frame is new (shared/collab-frame.ts).

import { makeAutoObservable, runInAction } from "mobx";
import { collabSocketUrl } from "../shared/collab-frame.ts";
import type { CollabKeysFrame } from "../shared/collab-frame.ts";
import type { MirrorControlFrame } from "../shared/mirror-frame.ts";

/**
 * Lifecycle of a collaborative connection. Identical to the mirror viewer's —
 * collaboration changes who can WRITE, not how the connection lives.
 *   - `connecting` — dialing / awaiting the first frame
 *   - `live`       — receiving pane bytes; keystrokes are accepted
 *   - `gone`       — the pane closed (terminal)
 *   - `error`      — could not establish the session (`message` says why)
 *   - `closed`     — the socket dropped before reaching a terminal state
 */
export type CollabStatus = "connecting" | "live" | "gone" | "error" | "closed";

export class CollabBridge {
  status: CollabStatus = "connecting";
  /** Browsers collaborating on / watching this pane (including this one). */
  viewers = 0;
  /** Pane geometry from the server; `0` until the first `size` frame. */
  cols = 0;
  rows = 0;
  errorMessage: string | null = null;

  private ws: WebSocket | null = null;
  private readonly byteHandlers = new Set<(data: Uint8Array) => void>();
  // Keystrokes produced before the socket is OPEN are buffered, not dropped, and
  // flushed in order on open. [LAW:no-silent-failure] early input is never lost.
  private readonly pendingKeys: string[] = [];

  constructor(
    private readonly wsBase: string,
    readonly paneId: number,
  ) {
    makeAutoObservable<this, "ws" | "byteHandlers" | "wsBase" | "pendingKeys">(
      this,
      {
        ws: false,
        byteHandlers: false,
        wsBase: false,
        pendingKeys: false,
      },
    );
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

  /** Dial the `/collab-ws` socket. Idempotent: a second call while live is a no-op. */
  connect(): void {
    if (this.ws !== null) return;
    const ws = new WebSocket(collabSocketUrl(this.wsBase, this.paneId));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.flushKeys();
    });
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

  /** Close the socket. */
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

  /**
   * Send raw terminal input (xterm's `onData` string) to the pane. tmux applies
   * it and the result fans back to every collaborator through the byte stream —
   * there is no local echo, so the screen is always the server's truth.
   * [LAW:one-source-of-truth] the pane, not the browser, decides what was typed.
   */
  sendKeys(keys: string): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.writeKeys(this.ws, keys);
    } else {
      this.pendingKeys.push(keys);
    }
  }

  private flushKeys(): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.pendingKeys.length > 0) {
      const keys = this.pendingKeys.shift();
      if (keys === undefined) break;
      this.writeKeys(this.ws, keys);
    }
  }

  private writeKeys(ws: WebSocket, keys: string): void {
    const frame: CollabKeysFrame = { kind: "keys", keys };
    ws.send(JSON.stringify(frame));
  }

  private handleControl(raw: string): void {
    let frame: MirrorControlFrame;
    try {
      frame = JSON.parse(raw) as MirrorControlFrame;
    } catch (err) {
      // [LAW:no-silent-failure] The server only ever sends JSON.stringify'd
      // frames, so a parse failure is a real protocol break — surface it in the
      // status (the bridge has no separate error channel) and log the offender.
      console.warn("[collab] malformed control frame:", raw, err);
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
