// examples/web-multiplexer/web/ws-client.ts
// Browser-side WebSocket client with request/response correlation.
//
// [LAW:single-enforcer] All outbound requests and inbound event routing
// flow through this client. Components subscribe via addEventListener;
// they do not touch the WebSocket directly.

import type {
  ClientToServer,
  ServerToClient,
  SerializedTmuxMessage,
} from "../shared/protocol.ts";
import type { CommandResponse } from "../../../src/protocol/types.js";

type EventHandler = (event: SerializedTmuxMessage) => void;
type ErrorHandler = (message: string, id?: string) => void;
type StateHandler = (state: "connecting" | "open" | "ready" | "closed") => void;

interface Pending {
  readonly resolve: (r: CommandResponse) => void;
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private nextId = 0;
  private state: "connecting" | "open" | "ready" | "closed" = "connecting";

  // [LAW:single-enforcer] All sends flow through sendRaw, which queues into
  // outbox if the socket isn't OPEN yet. The outbox is flushed when the
  // socket opens. This means callers can fire-and-correlate commands at any
  // time during startup without needing to gate on connection state.
  private readonly outbox: ClientToServer[] = [];

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

    ws.addEventListener("open", () => {
      this.setState("open");
      this.flushOutbox();
    });
    ws.addEventListener("close", () => {
      this.setState("closed");
      // Fail any outbox entries that never made it out. Pending
      // correlations (if any) will hang until the caller times out or
      // reconnects — that's a caller concern, not ours.
      if (this.outbox.length > 0) {
        this.emitError(
          `bridge closed with ${this.outbox.length} undelivered message(s)`,
        );
        this.outbox.length = 0;
      }
    });
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
      this.eventHandlers.forEach((h) => h(frame.event));
      return;
    }
    if (frame.kind === "response") {
      const entry = this.pending.get(frame.id);
      if (entry !== undefined) {
        this.pending.delete(frame.id);
        entry.resolve(frame.response);
      }
      return;
    }
    if (frame.kind === "error") {
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
        this.pending.set(msg.id, { resolve });
      }
      this.sendRaw(msg);
    });
  }

  private sendRaw(msg: ClientToServer): void {
    // [LAW:dataflow-not-control-flow] Every send follows the same path.
    // Whether it goes to the wire now or sits in outbox is a function of
    // socket state (a value), not a skipped operation.
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    this.outbox.push(msg);
  }

  private flushOutbox(): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.outbox.length > 0) {
      const msg = this.outbox.shift();
      if (msg === undefined) break;
      this.ws.send(JSON.stringify(msg));
    }
  }

  private id(): string {
    this.nextId += 1;
    return `r${this.nextId}`;
  }

  private setState(s: "connecting" | "open" | "ready" | "closed"): void {
    this.state = s;
    this.stateHandlers.forEach((h) => h(s));
  }

  private emitError(message: string, id?: string): void {
    this.errorHandlers.forEach((h) => h(message, id));
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
