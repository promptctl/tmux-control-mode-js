// examples/web-multiplexer/web/ws-client.ts
// Browser-side WebSocket client with request/response correlation.
//
// State is MobX-observable. The outbox + socket-ready relationship is
// expressed as a reaction: whenever the socket is open and the outbox is
// non-empty, drain the outbox. No imperative "on open, flush" glue —
// sends queue at any time and the reaction moves them to the wire when
// the socket is ready.

import { makeObservable, observable, action, reaction, runInAction } from "mobx";
import type {
  ClientToServer,
  ServerToClient,
  SerializedTmuxMessage,
} from "../shared/protocol.ts";
import type { CommandResponse } from "../../../src/protocol/types.js";

type EventHandler = (event: SerializedTmuxMessage) => void;
type ErrorHandler = (message: string, id?: string) => void;
type StateHandler = (state: "connecting" | "open" | "ready" | "closed") => void;

/**
 * Unified wire activity stream. One entry per thing that crosses the
 * WebSocket in either direction. The protocol inspector subscribes to
 * this stream; nothing in the main app does, so the cost when nobody's
 * listening is one empty Set iteration per event.
 *
 * [LAW:one-source-of-truth] This is the single stream of wire events.
 * The inspector builds a ring buffer from it; it never peeks at the
 * individual subscriber lists.
 */
export type WireEntry =
  | { readonly dir: "out"; readonly ts: number; readonly msg: ClientToServer }
  | {
      readonly dir: "in-event";
      readonly ts: number;
      readonly event: SerializedTmuxMessage;
    }
  | {
      readonly dir: "in-response";
      readonly ts: number;
      readonly id: string;
      readonly response: CommandResponse;
      readonly latencyMs: number;
      readonly request: ClientToServer | null;
    }
  | {
      readonly dir: "in-error";
      readonly ts: number;
      readonly id: string | null;
      readonly message: string;
    };

type WireHandler = (entry: WireEntry) => void;

interface Pending {
  readonly resolve: (r: CommandResponse) => void;
  readonly sentAt: number;
  readonly request: ClientToServer;
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly wireHandlers = new Set<WireHandler>();
  private nextId = 0;

  // Observable state — connection state and the outbox size drive the
  // auto-drain reaction below. `state` and `outbox` are the only pieces
  // of MobX-observed state on this class; everything else is either a
  // static subscriber list (events/errors) or imperative bookkeeping.
  state: "connecting" | "open" | "ready" | "closed" = "connecting";
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
    this.ws = ws;

    // Each listener just pokes an observable — the reaction above handles
    // the "what should we do about it" part. No imperative flush call
    // lives here; the drain reaction watches state + outbox and fires
    // automatically when the combination is drainable.
    ws.addEventListener("open", () => this.setState("open"));
    ws.addEventListener("close", () =>
      runInAction(() => {
        this.setState("closed");
        if (this.outbox.length > 0) {
          this.emitError(
            `bridge closed with ${this.outbox.length} undelivered message(s)`,
          );
          this.outbox.splice(0, this.outbox.length);
        }
      }),
    );
    ws.addEventListener("error", () => {
      this.emitError("WebSocket error");
    });
    ws.addEventListener("message", (ev) => {
      this.handleFrame(ev.data as string);
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
    this.pending.clear();
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
      this.emitWire({ dir: "in-event", ts: Date.now(), event: frame.event });
      this.eventHandlers.forEach((h) => h(frame.event));
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

  private send(msg: ClientToServer): Promise<CommandResponse> {
    return new Promise((resolve) => {
      if (msg.kind !== "detach") {
        this.pending.set(msg.id, {
          resolve,
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

  setState(s: "connecting" | "open" | "ready" | "closed"): void {
    this.state = s;
    this.stateHandlers.forEach((h) => h(s));
  }

  private emitError(message: string, id?: string): void {
    this.errorHandlers.forEach((h) => h(message, id));
  }

  private emitWire(entry: WireEntry): void {
    this.wireHandlers.forEach((h) => h(entry));
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

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
