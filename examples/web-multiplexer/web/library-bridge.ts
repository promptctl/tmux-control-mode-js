// examples/web-multiplexer/web/library-bridge.ts
// The demo's one `TmuxBridge`: adapts a library connection — the WebSocket
// connector's `WebSocketTmuxClient` or the Electron connector's
// `TmuxClientProxy` — to the push-subscription surface the page consumes.
//
// [LAW:single-enforcer] One adapter for both transports. Each entry point
//   hands it a way to open a connection and a firehose; everything the page
//   sees — calls, the wire log, events, pane bytes, connection state — is
//   shaped here, once.
// [LAW:dataflow-not-control-flow] Every call runs the same pipeline: log
//   `out`, invoke the connection, then log `in-response` (a tmux %error
//   included) or `in-error` (a bridge failure). Events and pane bytes each
//   have one path: log, then fan out.

// [LAW:one-way-deps] Browser-safe core only — the `/browser` subpath carries
// no Node transport coupling (see pane-stream-bridge.ts).
import {
  TmuxCommandError,
  isTmuxMessage,
  serverScope,
} from "@promptctl/tmux-control-mode-js/browser";
import type {
  ChunkPayload,
  ClientSizeSurface,
  ConnectionState,
  EmitterMessage,
  EmitterTmuxMessage,
  TmuxConnection,
} from "@promptctl/tmux-control-mode-js/browser";
import { BridgeError } from "@promptctl/tmux-control-mode-js/websocket/protocol";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import {
  refreshClientClearWindowSize,
  refreshClientSize,
  refreshClientWindowSize,
} from "@promptctl/tmux-control-mode-js/protocol";
import type {
  BridgeCall,
  ErrorHandler,
  EventHandler,
  FirehoseHandler,
  PaneOutputHandler,
  StateHandler,
  TmuxBridge,
  WireEntry,
  WireHandler,
} from "./bridge.ts";

/** What both library connections offer the page. */
export interface BridgeConnection extends TmuxConnection, ClientSizeSurface {
  sendKeys(target: string, keys: string): Promise<CommandResponse>;
  close(): void | Promise<void>;
}

/** Open a connection; `reportError` hears the failures it reports itself. */
export type OpenConnection = (
  reportError: (message: string) => void,
) => BridgeConnection;

/** The cross-terminal byte feed, which lives beside the tmux connection. */
export interface Firehose {
  start(): void;
  stop(): void;
}

/** Build the firehose once; it delivers to `sink` and reports to `reportError`. */
export type OpenFirehose = (
  sink: FirehoseHandler,
  reportError: (message: string) => void,
) => Firehose;

export interface LibraryBridgeOptions {
  /** Clock for the wire log's timestamps and latencies. */
  readonly now?: () => number;
  /** Hears a page handler's throw; by default it is logged to the console. */
  readonly onObserverError?: (err: unknown) => void;
}

/** The state before the first `connect()` and after `disconnect()`. */
const DISPOSED: ConnectionState = { status: "closed", reason: "disposed" };

export class LibraryBridge implements TmuxBridge {
  private connection: BridgeConnection | null = null;
  private detachBytes: () => void = () => undefined;
  private state: ConnectionState = DISPOSED;
  private nextId = 0;
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly paneOutputHandlers = new Set<PaneOutputHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly wireHandlers = new Set<WireHandler>();
  private readonly firehoseHandlers = new Set<FirehoseHandler>();
  private readonly firehose: Firehose;
  private readonly now: () => number;
  private readonly onObserverError: (err: unknown) => void;

  constructor(
    private readonly openConnection: OpenConnection,
    openFirehose: OpenFirehose,
    options: LibraryBridgeOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.onObserverError =
      options.onObserverError ??
      ((err) => console.error("[bridge] a handler threw:", err));
    this.firehose = openFirehose(
      (paneId, data) => this.notifyAll(this.firehoseHandlers, paneId, data),
      (message) => this.reportError(`firehose: ${message}`),
    );
  }

  // ---------------------------------------------------------------------------
  // Calls
  // ---------------------------------------------------------------------------

  execute(command: string): Promise<CommandResponse> {
    return this.call({ kind: "execute", id: this.allocId(), command }, (c) =>
      c.execute(command),
    );
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    return this.call(
      { kind: "sendKeys", id: this.allocId(), target, keys },
      (c) => c.sendKeys(target, keys),
    );
  }

  // A size call goes through the connection's own size surface, which the
  // library's bridge withdraws when this page goes; the wire log shows the
  // tmux command it amounts to.
  setSize(width: number, height: number): Promise<CommandResponse> {
    return this.call(
      {
        kind: "execute",
        id: this.allocId(),
        command: refreshClientSize(width, height),
      },
      (c) => c.setSize(width, height),
    );
  }

  setWindowSize(
    windowId: number,
    width: number,
    height: number,
  ): Promise<CommandResponse> {
    return this.call(
      {
        kind: "execute",
        id: this.allocId(),
        command: refreshClientWindowSize(windowId, width, height),
      },
      (c) => c.setWindowSize(windowId, width, height),
    );
  }

  clearWindowSize(windowId: number): Promise<CommandResponse> {
    return this.call(
      {
        kind: "execute",
        id: this.allocId(),
        command: refreshClientClearWindowSize(windowId),
      },
      (c) => c.clearWindowSize(windowId),
    );
  }

  startFirehose(): void {
    this.firehose.start();
  }

  stopFirehose(): void {
    this.firehose.stop();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  connect(): void {
    if (this.connection !== null && this.state.status !== "closed") return;
    this.release();
    const connection = this.openConnection((message) =>
      this.reportError(message),
    );
    connection.on("*", this.onMessage);
    // [LAW:dataflow-not-control-flow] Pane bytes arrive only through the byte
    //   sink, never on `on("*")`; they stay a channel of their own.
    // [LAW:one-source-of-truth] With only this server-scope sink, the
    //   connection's router keeps no topology and sends no query:
    //   BridgePaneStreamClient's router is the page's one topology, and it
    //   outlives the connection a reconnect replaces.
    this.detachBytes = connection.attachBytesSink(
      {
        write: (chunk) => this.deliverPaneOutput(chunk),
        end: () => undefined,
      },
      { scope: serverScope },
    );
    this.connection = connection;
    // [LAW:one-source-of-truth] The connection holds its own state; the bridge
    //   reads it once subscribed and follows its transitions after.
    this.setState(connection.connectionState);
  }

  disconnect(): void {
    this.release();
    this.setState(DISPOSED);
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  onEvent(h: EventHandler): () => void {
    return subscribe(this.eventHandlers, h);
  }

  onPaneOutput(h: PaneOutputHandler): () => void {
    return subscribe(this.paneOutputHandlers, h);
  }

  onError(h: ErrorHandler): () => void {
    return subscribe(this.errorHandlers, h);
  }

  onState(h: StateHandler): () => void {
    const unsubscribe = subscribe(this.stateHandlers, h);
    h(this.state);
    return unsubscribe;
  }

  onWire(h: WireHandler): () => void {
    return subscribe(this.wireHandlers, h);
  }

  onFirehose(h: FirehoseHandler): () => void {
    return subscribe(this.firehoseHandlers, h);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private readonly onMessage = (msg: EmitterMessage): void => {
    if (msg.type === "connection-state") {
      this.setState(msg.state);
      return;
    }
    if (isTmuxMessage(msg)) this.deliverEvent(msg);
  };

  private release(): void {
    const connection = this.connection;
    if (connection === null) return;
    this.connection = null;
    this.detachBytes();
    this.detachBytes = () => undefined;
    connection.off("*", this.onMessage);
    Promise.resolve(connection.close()).catch((err: unknown) =>
      this.reportError(`closing the connection failed: ${describe(err)}`),
    );
  }

  private call(
    call: BridgeCall,
    invoke: (connection: BridgeConnection) => Promise<CommandResponse>,
  ): Promise<CommandResponse> {
    const connection = this.connection;
    if (connection === null) {
      const error = new BridgeError(
        "BRIDGE_CLOSED",
        `cannot ${call.kind}: bridge is not connected`,
      );
      this.logFailure(call, error);
      return Promise.reject(error);
    }
    const sentAt = this.now();
    this.emitWire({ dir: "out", ts: sentAt, call });
    const reply = invoke(connection);
    // The log hangs off a side branch; the caller gets `reply` untouched.
    // A tmux %error is tmux's reply, so the log shows it as the response it
    // is, and only a bridge failure reaches onError.
    reply.then(
      (response) => this.logResponse(call, sentAt, response),
      (err: unknown) =>
        err instanceof TmuxCommandError
          ? this.logResponse(call, sentAt, err.response)
          : this.logFailure(call, err),
    );
    return reply;
  }

  private logResponse(
    call: BridgeCall,
    sentAt: number,
    response: CommandResponse,
  ): void {
    const now = this.now();
    this.emitWire({
      dir: "in-response",
      ts: now,
      id: call.id,
      response,
      latencyMs: now - sentAt,
      call,
    });
  }

  private logFailure(call: BridgeCall, err: unknown): void {
    const message = describe(err);
    this.emitWire({ dir: "in-error", ts: this.now(), id: call.id, message });
    this.notifyAll(this.errorHandlers, message, call.id);
  }

  private reportError(message: string): void {
    this.emitWire({ dir: "in-error", ts: this.now(), id: null, message });
    this.notifyAll(this.errorHandlers, message);
  }

  private deliverEvent(ev: EmitterTmuxMessage): void {
    this.emitWire({ dir: "in-event", ts: this.now(), event: ev });
    this.notifyAll(this.eventHandlers, ev);
  }

  private deliverPaneOutput(chunk: ChunkPayload): void {
    this.emitWire({ dir: "in-output", ts: this.now(), chunk });
    this.notifyAll(this.paneOutputHandlers, chunk);
  }

  private setState(next: ConnectionState): void {
    if (next === this.state) return;
    this.state = next;
    this.notifyAll(this.stateHandlers, next);
  }

  private emitWire(entry: WireEntry): void {
    this.notifyAll(this.wireHandlers, entry);
  }

  /**
   * Call every handler, each in isolation: these run inside the library's own
   * delivery, where one page handler's throw would otherwise stop the rest and
   * surface in the connector. [LAW:no-silent-failure] The throw is reported.
   */
  private notifyAll<A extends unknown[]>(
    handlers: ReadonlySet<(...args: A) => void>,
    ...args: A
  ): void {
    for (const h of [...handlers]) {
      try {
        h(...args);
      } catch (err) {
        this.onObserverError(err);
      }
    }
  }

  private allocId(): string {
    this.nextId += 1;
    return `e${this.nextId}`;
  }
}

function subscribe<H>(handlers: Set<H>, h: H): () => void {
  handlers.add(h);
  return () => {
    handlers.delete(h);
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
