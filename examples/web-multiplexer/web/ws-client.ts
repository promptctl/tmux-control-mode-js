// examples/web-multiplexer/web/ws-client.ts
// Browser-side WebSocket implementation of TmuxBridge.
//
// State is MobX-observable. The outbox + socket-ready relationship is
// expressed as a reaction: whenever the socket is open and the outbox is
// non-empty, drain the outbox. No imperative "on open, flush" glue —
// sends queue at any time and the reaction moves them to the wire when
// the socket is ready.
//
// [LAW:one-source-of-truth] WireEntry, ConnState, and the handler shapes
// live in ./bridge.ts so a second TmuxBridge implementation can't redeclare
// them with a drifting shape. This file owns the wire mechanics (socket
// lifecycle, JSON framing, request/response correlation) and nothing else.

import {
  makeObservable,
  observable,
  action,
  reaction,
  runInAction,
} from "mobx";
import type { ClientToServer, ServerToClient } from "../shared/protocol.ts";
import type {
  CommandResponse,
  TmuxMessage,
} from "@promptctl/tmux-control-mode-js/protocol";
import {
  isPaneOutputFrame,
  decodePaneOutput,
  BridgeError,
} from "@promptctl/tmux-control-mode-js/websocket/protocol";
import {
  isFirehoseFrame,
  decodeFirehoseFrame,
} from "../shared/firehose-frame.ts";
import type {
  ConnState,
  ErrorHandler,
  EventHandler,
  FirehoseHandler,
  StateHandler,
  TmuxBridge,
  WireEntry,
  WireHandler,
} from "./bridge.ts";

interface Pending {
  readonly resolve: (r: CommandResponse) => void;
  readonly reject: (e: BridgeError) => void;
  readonly sentAt: number;
  readonly request: ClientToServer;
}

export class WebSocketBridge implements TmuxBridge {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly wireHandlers = new Set<WireHandler>();
  private readonly firehoseHandlers = new Set<FirehoseHandler>();
  private nextId = 0;

  // Observable state — connection state and the outbox size drive the
  // auto-drain reaction below. `state` and `outbox` are the only pieces
  // of MobX-observed state on this class; everything else is either a
  // static subscriber list (events/errors) or imperative bookkeeping.
  state: ConnState = "connecting";
  outbox: ClientToServer[] = [];

  constructor() {
    makeObservable(this, {
      state: observable,
      outbox: observable.shallow, // we don't observe mutations to the messages themselves
      setState: action,
      enqueue: action,
      drainOutbox: action,
    });

    // [LAW:dataflow-not-control-flow] The data dependency "drain the
    // outbox whenever the socket is usable and the outbox has items" is
    // declared once, here. "Usable" means `open` OR `ready` — both map to
    // a WebSocket in OPEN readyState; `ready` just adds "tmux handshake
    // done" on top.
    reaction(
      () => ({
        usable: this.state === "open" || this.state === "ready",
        size: this.outbox.length,
      }),
      (curr) => {
        if (curr.usable && curr.size > 0) this.drainOutbox();
      },
      { fireImmediately: true },
    );
  }

  connect(url: string): void {
    // [LAW:single-enforcer] Only one live WebSocket per client. React
    // StrictMode double-invokes effects in dev; without this guard a
    // second connect() would open a second socket and every event would
    // be delivered twice to the same handlers.
    if (
      this.ws !== null &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.setState("connecting");
    const ws = new WebSocket(url);
    // Pane bytes arrive as binary pane-output frames; everything else is
    // JSON text. arraybuffer (not Blob) lets `decodePaneOutput` read the
    // frame synchronously in the message handler.
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    // Each listener just pokes an observable — the reaction above handles
    // the "what should we do about it" part. No imperative flush call
    // lives here; the drain reaction watches state + outbox and fires
    // automatically when the combination is drainable.
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.setState("open");
    });
    ws.addEventListener("close", () =>
      runInAction(() => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.setState("closed");
        if (this.outbox.length > 0) {
          this.emitError(
            `bridge closed with ${this.outbox.length} undelivered message(s)`,
          );
          this.outbox.splice(0, this.outbox.length);
        }
        this.settlePendingOnClose("bridge socket closed");
      }),
    );
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return;
      this.emitError("WebSocket error");
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      // [LAW:dataflow-not-control-flow] The frame's runtime type is the
      // discriminator: ArrayBuffer → binary pane-output, string → JSON.
      if (ev.data instanceof ArrayBuffer) {
        this.handleBinary(ev.data);
      } else {
        this.handleFrame(ev.data as string);
      }
    });
  }

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
    // [LAW:no-ambient-temporal-coupling] Same order as the close listener:
    // setState("closed") FIRST, then settlePendingOnClose. If an onState
    // handler reacts to "closed" by synchronously issuing a new
    // execute()/sendKeys(), that entry lands in `pending` during the
    // setState fan-out — settling it after (not before) means it's still
    // swept by this same teardown rather than left to hang forever.
    runInAction(() => {
      this.setState("closed");
      if (this.outbox.length > 0) {
        this.emitError(
          `bridge closed with ${this.outbox.length} undelivered message(s)`,
        );
        this.outbox.splice(0, this.outbox.length);
      }
      this.settlePendingOnClose("client disconnect");
    });
  }

  /**
   * Reject every in-flight command — the only settlement point for the
   * `pending` map. tmux will never reply to these (the socket is gone), so
   * an awaiting caller (DemoStore.installSubscriptions, captureSeeds,
   * ConsoleStore commands, ...) must see a rejection, not a hang.
   * [LAW:no-silent-failure] [LAW:single-enforcer] one settlement path for
   * both the user-initiated disconnect() and an unplanned socket close.
   */
  private settlePendingOnClose(reason: string): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.reject(new BridgeError("BRIDGE_CLOSED", reason));
    }
  }

  private handleFrame(raw: string): void {
    let frame: ServerToClient;
    try {
      frame = JSON.parse(raw) as ServerToClient;
    } catch {
      this.emitError("invalid JSON frame from bridge");
      return;
    }

    if (frame.kind === "ready") {
      this.setState("ready");
      return;
    }
    if (frame.kind === "event") {
      // Non-byte state events ride the JSON channel as plain TmuxMessages;
      // no decode step. Pane bytes never appear here — they arrive as binary
      // frames handled by `handleBinary`.
      this.deliverEvent(frame.event);
      return;
    }
    if (frame.kind === "response") {
      const entry = this.pending.get(frame.id);
      const now = Date.now();
      const latencyMs = entry !== undefined ? now - entry.sentAt : 0;
      this.emitWire({
        dir: "in-response",
        ts: now,
        id: frame.id,
        response: frame.response,
        latencyMs,
        request: entry?.request ?? null,
      });
      if (entry !== undefined) {
        this.pending.delete(frame.id);
        entry.resolve(frame.response);
      }
      return;
    }
    if (frame.kind === "error") {
      this.emitWire({
        dir: "in-error",
        ts: Date.now(),
        id: frame.id ?? null,
        message: frame.message,
      });
      this.emitError(frame.message, frame.id);
      // [LAW:no-silent-failure] This ErrorFrame is the bridge server's outer
      // dispatch-failure path (server/bridge.ts) — distinct from a tmux
      // %error, which already resolves via a ResponseFrame{success:false}.
      // If it carries the id of a still-pending execute()/sendKeys(), that
      // promise must settle here or it hangs forever (settlePendingOnClose
      // already ran, or never runs, for a connection that stays open).
      if (frame.id !== undefined) {
        const entry = this.pending.get(frame.id);
        if (entry !== undefined) {
          this.pending.delete(frame.id);
          entry.reject(new BridgeError("BRIDGE_INTERNAL", frame.message));
        }
      }
    }
  }

  execute(command: string): Promise<CommandResponse> {
    return this.send({ kind: "execute", id: this.id(), command });
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    return this.send({ kind: "sendKeys", id: this.id(), target, keys });
  }

  detach(): void {
    this.sendRaw({ kind: "detach", id: this.id() });
  }

  startFirehose(): void {
    this.sendRaw({ kind: "startFirehose", id: this.id() });
  }

  stopFirehose(): void {
    this.sendRaw({ kind: "stopFirehose", id: this.id() });
  }

  onFirehose(h: FirehoseHandler): () => void {
    this.firehoseHandlers.add(h);
    return () => this.firehoseHandlers.delete(h);
  }

  private send(msg: ClientToServer): Promise<CommandResponse> {
    return new Promise((resolve, reject) => {
      if (msg.kind !== "detach") {
        this.pending.set(msg.id, {
          resolve,
          reject,
          sentAt: Date.now(),
          request: msg,
        });
      }
      this.sendRaw(msg);
    });
  }

  /**
   * Single send path. Messages are always enqueued; the MobX drain
   * reaction decides when they go to the wire based on socket state.
   *
   * [LAW:dataflow-not-control-flow] No branching on socket state here.
   * The reaction is the sole effect that moves messages outward.
   */
  private sendRaw(msg: ClientToServer): void {
    this.enqueue(msg);
  }

  enqueue(msg: ClientToServer): void {
    this.outbox.push(msg);
  }

  drainOutbox(): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    const ws = this.ws;
    while (this.outbox.length > 0) {
      const msg = this.outbox.shift();
      if (msg === undefined) break;
      ws.send(JSON.stringify(msg));
      this.emitWire({ dir: "out", ts: Date.now(), msg });
    }
  }

  private id(): string {
    this.nextId += 1;
    return `r${this.nextId}`;
  }

  setState(s: ConnState): void {
    this.state = s;
    this.stateHandlers.forEach((h) => h(s));
  }

  private emitError(message: string, id?: string): void {
    this.errorHandlers.forEach((h) => h(message, id));
  }

  private emitWire(entry: WireEntry): void {
    this.wireHandlers.forEach((h) => h(entry));
  }

  /**
   * Decode a binary pane-output frame into a TmuxMessage and deliver it
   * through the same path as JSON events. The library owns the wire format
   * (`decodePaneOutput` matches the server's `attachWebSocketSink` encoder);
   * the demo never touches base64 or hand-rolls a byte decoder.
   *
   * [LAW:single-enforcer] One decode path for pane bytes — the library's.
   * [LAW:no-silent-failure] A malformed frame is surfaced as an error, never
   * swallowed into empty terminal output.
   */
  private handleBinary(buf: ArrayBuffer): void {
    const bytes = new Uint8Array(buf);
    // [LAW:dataflow-not-control-flow] The leading magic byte is the channel
    // discriminator: 0x7F (library) → attached pane output → event fan-out;
    // 0xF1 → firehose bytes → firehose fan-out. The two channels never cross,
    // so a tapped line can't also reach the terminal as attached output.
    if (isFirehoseFrame(bytes)) {
      const chunk = decodeFirehoseFrame(bytes);
      this.firehoseHandlers.forEach((h) => h(chunk.paneId, chunk.data));
      return;
    }
    if (!isPaneOutputFrame(bytes)) {
      const message = "unrecognized binary frame from bridge";
      this.emitWire({ dir: "in-error", ts: Date.now(), id: null, message });
      this.emitError(message);
      return;
    }
    let msg: TmuxMessage;
    try {
      msg = decodePaneOutput(bytes);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "invalid pane-output frame";
      this.emitWire({ dir: "in-error", ts: Date.now(), id: null, message });
      this.emitError(message);
      return;
    }
    this.deliverEvent(msg);
  }

  /**
   * Single delivery path for an inbound event — JSON state events and decoded
   * binary pane-output frames both flow through here, so every consumer and
   * the in-event WireEntry see one uniform TmuxMessage shape (the same shape
   * the Electron transport delivers natively). [LAW:one-type-per-behavior]
   */
  private deliverEvent(ev: TmuxMessage): void {
    this.emitWire({ dir: "in-event", ts: Date.now(), event: ev });
    this.eventHandlers.forEach((h) => h(ev));
  }

  onWire(h: WireHandler): () => void {
    this.wireHandlers.add(h);
    return () => this.wireHandlers.delete(h);
  }

  onEvent(h: EventHandler): () => void {
    this.eventHandlers.add(h);
    return () => this.eventHandlers.delete(h);
  }

  onError(h: ErrorHandler): () => void {
    this.errorHandlers.add(h);
    return () => this.errorHandlers.delete(h);
  }

  onState(h: StateHandler): () => void {
    this.stateHandlers.add(h);
    h(this.state);
    return () => this.stateHandlers.delete(h);
  }
}
