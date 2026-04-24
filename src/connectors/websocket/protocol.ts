// src/connectors/websocket/protocol.ts
// Wire protocol v1 for the tmux-control-mode-js WebSocket bridge.
//
// One WebSocket carries two channels:
//   - Control plane: JSON text frames (versioned, discriminated).
//   - Data plane:    Binary frames for pane output (no base64 bloat).
//
// Pane output dominates bandwidth on any live tmux session, so the data plane
// is kept cheap: a tiny fixed-size header + the raw pane bytes. Every other
// message is low-rate and rides JSON.
//
// [LAW:one-source-of-truth] Every frame shape, RPC method name, and error
// code lives here. Both sides of the bridge import from this file.
// [LAW:one-type-per-behavior] ClientFrame and ServerFrame are discriminated
// unions — a single `k` field dispatches every receiver.

import type {
  CommandResponse,
  TmuxMessage,
} from "../../protocol/types.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Protocol version. Bumped whenever wire compatibility breaks. The server
 * refuses `hello` frames whose `protocol` field does not equal this constant.
 */
export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Canonical error codes for every failure a bridge call can surface.
 * Browser consumers branch on `code`, not on message text.
 *
 * [LAW:one-source-of-truth] Every code used anywhere in the bridge must be
 * listed here. Adding a new failure mode means adding a variant.
 */
export type BridgeErrorCode =
  /** tmux replied with %error (a tmux-level command failure). */
  | "TMUX_ERROR"
  /** Malformed frame, unknown discriminator, wrong protocol version. */
  | "BRIDGE_PROTOCOL_ERROR"
  /** `authenticate()` hook rejected the connection at upgrade time. */
  | "BRIDGE_AUTH_DENIED"
  /** `authorize()` hook rejected a specific call. */
  | "BRIDGE_COMMAND_DENIED"
  /** Called a method not present in the RPC dispatch table. */
  | "BRIDGE_UNKNOWN_METHOD"
  /** Per-connection rate limit exceeded. */
  | "BRIDGE_RATE_LIMITED"
  /** Deadline reached before the response arrived. */
  | "BRIDGE_TIMEOUT"
  /** Connection closed while the call was in flight. */
  | "BRIDGE_CLOSED"
  /** Unexpected bridge-internal error. */
  | "BRIDGE_INTERNAL";

export interface BridgeErrorPayload {
  readonly code: BridgeErrorCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// RPC methods
// ---------------------------------------------------------------------------

/**
 * Every TmuxClient method the bridge can proxy. One entry per public method
 * on TmuxClient — changing this set is the public surface of the bridge.
 *
 * [LAW:one-source-of-truth] Both `server.ts` DISPATCH and `client.ts` call
 * helpers derive their method names from this type.
 */
export type RpcMethod =
  | "execute"
  | "listWindows"
  | "listPanes"
  | "sendKeys"
  | "splitWindow"
  | "setSize"
  | "setPaneAction"
  | "setFlags"
  | "clearFlags"
  | "requestReport"
  | "queryClipboard"
  | "subscribe"
  | "unsubscribe"
  | "detach";

/**
 * "Fire" methods produce no tmux response, so the bridge synthesizes a
 * success CommandResponse as soon as the local invocation returns. Only
 * `detach` qualifies today — tmux closes the control stream in response,
 * so there is no %end to await. `subscribe`/`unsubscribe` look fire-like
 * but TmuxClient exposes them as Promise<CommandResponse> because tmux DOES
 * emit a %begin/%end pair for them.
 */
export const RPC_FIRE_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "detach",
]);

export function isFireMethod(method: RpcMethod): boolean {
  return RPC_FIRE_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// Event messages (control plane)
//
// Pane output (`%output`, `%extended-output`) never rides a JSON event frame;
// it goes out as a binary frame. If a SerializedEventMessage with one of
// those types ever materializes, the sender has a bug.
// ---------------------------------------------------------------------------

export type SerializedEventMessage = Exclude<
  TmuxMessage,
  { type: "output" } | { type: "extended-output" }
>;

// ---------------------------------------------------------------------------
// Client → Server frames (JSON)
// ---------------------------------------------------------------------------

export interface HelloFrame {
  readonly v: 1;
  readonly k: "hello";
  readonly protocol: typeof PROTOCOL_VERSION;
}

export interface CallFrame {
  readonly v: 1;
  readonly k: "call";
  readonly id: string;
  readonly method: RpcMethod;
  readonly args: readonly unknown[];
}

export interface PingFrame {
  readonly v: 1;
  readonly k: "ping";
  readonly id: string;
}

export interface ByeFrame {
  readonly v: 1;
  readonly k: "bye";
}

export type ClientFrame = HelloFrame | CallFrame | PingFrame | ByeFrame;

// ---------------------------------------------------------------------------
// Server → Client frames (JSON)
// ---------------------------------------------------------------------------

export interface WelcomeLimits {
  /** Max ms the server will wait for a tmux response per call. */
  readonly requestTimeoutMs: number;
  /** Interval at which the server will ping. */
  readonly heartbeatIntervalMs: number;
  /** Max in-flight calls permitted per connection. */
  readonly maxInflight: number;
}

export interface WelcomeFrame {
  readonly v: 1;
  readonly k: "welcome";
  readonly protocol: typeof PROTOCOL_VERSION;
  readonly limits: WelcomeLimits;
}

export interface EventFrame {
  readonly v: 1;
  readonly k: "event";
  readonly msg: SerializedEventMessage;
}

export interface ResultOkFrame {
  readonly v: 1;
  readonly k: "result";
  readonly id: string;
  readonly ok: true;
  readonly response: CommandResponse;
}

export interface ResultErrFrame {
  readonly v: 1;
  readonly k: "result";
  readonly id: string;
  readonly ok: false;
  readonly error: BridgeErrorPayload;
}

export type ResultFrame = ResultOkFrame | ResultErrFrame;

export interface PongFrame {
  readonly v: 1;
  readonly k: "pong";
  readonly id: string;
}

export interface DrainingFrame {
  readonly v: 1;
  readonly k: "draining";
  /** Absolute ms-since-epoch deadline for existing calls to finish. */
  readonly deadlineMs: number;
}

export interface FatalErrorFrame {
  readonly v: 1;
  readonly k: "error";
  readonly fatal: true;
  readonly error: BridgeErrorPayload;
}

export type ServerFrame =
  | WelcomeFrame
  | EventFrame
  | ResultFrame
  | PongFrame
  | DrainingFrame
  | FatalErrorFrame;

// ---------------------------------------------------------------------------
// Binary frame: pane output
//
// Layout (network / big-endian byte order):
//
//   byte 0:        magic (0x7F)
//   byte 1:        flags
//                    bit 0: extended   — when set, age field is present
//                    bit 1..7: reserved, must be zero
//   bytes 2-5:     paneId  (uint32 BE)
//   bytes 6-9:     age     (uint32 BE, only when extended flag set)
//   remaining:     pane bytes verbatim (no encoding, no framing)
//
// [LAW:one-source-of-truth] encodePaneOutput and decodePaneOutput are the
// only functions that know this layout. Anything that ever peeks at the first
// byte of a binary frame goes through `isPaneOutputFrame`.
// ---------------------------------------------------------------------------

/** Magic byte identifying a pane-output binary frame. */
export const PANE_OUTPUT_MAGIC = 0x7f;

const FLAG_EXTENDED = 0x01;

const HEADER_BASE = 6;
const HEADER_EXTENDED = 10;

export type PaneOutputMessage = Extract<
  TmuxMessage,
  { type: "output" } | { type: "extended-output" }
>;

export function isPaneOutputFrame(buf: Uint8Array): boolean {
  return buf.length > 0 && buf[0] === PANE_OUTPUT_MAGIC;
}

// [LAW:dataflow-not-control-flow] Same encode pipeline for both output and
// extended-output; the `extended` flag selects a value (header length,
// whether `age` is written), not a separate code path.
export function encodePaneOutput(msg: PaneOutputMessage): Uint8Array {
  const extended = msg.type === "extended-output";
  const headerLen = extended ? HEADER_EXTENDED : HEADER_BASE;
  const out = new Uint8Array(headerLen + msg.data.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = PANE_OUTPUT_MAGIC;
  out[1] = extended ? FLAG_EXTENDED : 0;
  view.setUint32(2, msg.paneId, false);
  if (extended) view.setUint32(6, msg.age, false);
  out.set(msg.data, headerLen);
  return out;
}

export function decodePaneOutput(buf: Uint8Array): PaneOutputMessage {
  if (buf.length < HEADER_BASE) {
    throw new BridgeProtocolError(
      `pane-output frame truncated: got ${buf.length} bytes, need >=${HEADER_BASE}`,
    );
  }
  if (buf[0] !== PANE_OUTPUT_MAGIC) {
    throw new BridgeProtocolError(
      `pane-output frame has wrong magic byte 0x${buf[0]
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
  const flags = buf[1];
  if ((flags & ~FLAG_EXTENDED) !== 0) {
    throw new BridgeProtocolError(
      `pane-output frame has unknown flag bits set: 0x${flags
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const paneId = view.getUint32(2, false);
  const extended = (flags & FLAG_EXTENDED) !== 0;
  if (!extended) {
    return { type: "output", paneId, data: buf.slice(HEADER_BASE) };
  }
  if (buf.length < HEADER_EXTENDED) {
    throw new BridgeProtocolError(
      `extended pane-output frame truncated: got ${buf.length} bytes, need >=${HEADER_EXTENDED}`,
    );
  }
  const age = view.getUint32(6, false);
  return {
    type: "extended-output",
    paneId,
    age,
    data: buf.slice(HEADER_EXTENDED),
  };
}

// ---------------------------------------------------------------------------
// Typed errors
//
// BridgeError is thrown at the seams where untyped wire data becomes typed
// objects. Anywhere else the code returns typed results; control never flows
// through `any`.
// ---------------------------------------------------------------------------

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }

  toPayload(): BridgeErrorPayload {
    return { code: this.code, message: this.message };
  }

  static fromPayload(p: BridgeErrorPayload): BridgeError {
    return new BridgeError(p.code, p.message);
  }
}

export class BridgeProtocolError extends BridgeError {
  constructor(message: string) {
    super("BRIDGE_PROTOCOL_ERROR", message);
    this.name = "BridgeProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
//
// Wire → typed. These functions do ALL validation for the bridge. Downstream
// code operates on parsed types and never re-checks wire shape.
// ---------------------------------------------------------------------------

export function parseClientFrame(raw: string): ClientFrame {
  const parsed = safeJsonParse(raw);
  assertFrameEnvelope(parsed);
  const k = (parsed as { k: unknown }).k;
  if (k === "hello") return parseHello(parsed);
  if (k === "call") return parseCall(parsed);
  if (k === "ping") return parsePing(parsed);
  if (k === "bye") return { v: 1, k: "bye" };
  throw new BridgeProtocolError(`unknown client frame kind: ${String(k)}`);
}

export function parseServerFrame(raw: string): ServerFrame {
  const parsed = safeJsonParse(raw);
  assertFrameEnvelope(parsed);
  const k = (parsed as { k: unknown }).k;
  if (k === "welcome") return parseWelcome(parsed);
  if (k === "event") return parseEvent(parsed);
  if (k === "result") return parseResult(parsed);
  if (k === "pong") return parsePong(parsed);
  if (k === "draining") return parseDraining(parsed);
  if (k === "error") return parseFatal(parsed);
  throw new BridgeProtocolError(`unknown server frame kind: ${String(k)}`);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new BridgeProtocolError(
      `invalid JSON frame: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function assertFrameEnvelope(x: unknown): void {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new BridgeProtocolError("frame must be a JSON object");
  }
  const obj = x as { v?: unknown };
  if (obj.v !== PROTOCOL_VERSION) {
    throw new BridgeProtocolError(
      `unsupported protocol version: ${String(obj.v)} (expected ${PROTOCOL_VERSION})`,
    );
  }
}

function parseHello(x: unknown): HelloFrame {
  const o = x as { protocol?: unknown };
  if (o.protocol !== PROTOCOL_VERSION) {
    throw new BridgeProtocolError(
      `hello.protocol must equal ${PROTOCOL_VERSION}`,
    );
  }
  return { v: 1, k: "hello", protocol: PROTOCOL_VERSION };
}

function parseCall(x: unknown): CallFrame {
  const o = x as {
    id?: unknown;
    method?: unknown;
    args?: unknown;
  };
  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new BridgeProtocolError("call.id must be a non-empty string");
  }
  if (typeof o.method !== "string") {
    throw new BridgeProtocolError("call.method must be a string");
  }
  if (!Array.isArray(o.args)) {
    throw new BridgeProtocolError("call.args must be an array");
  }
  return {
    v: 1,
    k: "call",
    id: o.id,
    method: o.method as RpcMethod,
    args: o.args,
  };
}

function parsePing(x: unknown): PingFrame {
  const o = x as { id?: unknown };
  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new BridgeProtocolError("ping.id must be a non-empty string");
  }
  return { v: 1, k: "ping", id: o.id };
}

function parseWelcome(x: unknown): WelcomeFrame {
  const o = x as { protocol?: unknown; limits?: unknown };
  if (o.protocol !== PROTOCOL_VERSION) {
    throw new BridgeProtocolError(
      `welcome.protocol must equal ${PROTOCOL_VERSION}`,
    );
  }
  const l = o.limits as Partial<WelcomeLimits> | undefined;
  if (
    l === undefined ||
    typeof l.requestTimeoutMs !== "number" ||
    typeof l.heartbeatIntervalMs !== "number" ||
    typeof l.maxInflight !== "number"
  ) {
    throw new BridgeProtocolError("welcome.limits missing or malformed");
  }
  return {
    v: 1,
    k: "welcome",
    protocol: PROTOCOL_VERSION,
    limits: {
      requestTimeoutMs: l.requestTimeoutMs,
      heartbeatIntervalMs: l.heartbeatIntervalMs,
      maxInflight: l.maxInflight,
    },
  };
}

function parseEvent(x: unknown): EventFrame {
  const o = x as { msg?: unknown };
  if (typeof o.msg !== "object" || o.msg === null) {
    throw new BridgeProtocolError("event.msg must be an object");
  }
  // Trust the server's TmuxMessage shape here; the parser upstream already
  // validated it before it reached us. Clients re-validating would duplicate
  // the protocol layer. Types assert what the server promises to send.
  return { v: 1, k: "event", msg: o.msg as SerializedEventMessage };
}

function parseResult(x: unknown): ResultFrame {
  const o = x as {
    id?: unknown;
    ok?: unknown;
    response?: unknown;
    error?: unknown;
  };
  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new BridgeProtocolError("result.id must be a non-empty string");
  }
  if (o.ok === true) {
    if (typeof o.response !== "object" || o.response === null) {
      throw new BridgeProtocolError("result.response must be an object");
    }
    return {
      v: 1,
      k: "result",
      id: o.id,
      ok: true,
      response: o.response as CommandResponse,
    };
  }
  if (o.ok === false) {
    return {
      v: 1,
      k: "result",
      id: o.id,
      ok: false,
      error: parseErrorPayload(o.error),
    };
  }
  throw new BridgeProtocolError("result.ok must be a boolean");
}

function parsePong(x: unknown): PongFrame {
  const o = x as { id?: unknown };
  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new BridgeProtocolError("pong.id must be a non-empty string");
  }
  return { v: 1, k: "pong", id: o.id };
}

function parseDraining(x: unknown): DrainingFrame {
  const o = x as { deadlineMs?: unknown };
  if (typeof o.deadlineMs !== "number") {
    throw new BridgeProtocolError("draining.deadlineMs must be a number");
  }
  return { v: 1, k: "draining", deadlineMs: o.deadlineMs };
}

function parseFatal(x: unknown): FatalErrorFrame {
  const o = x as { fatal?: unknown; error?: unknown };
  if (o.fatal !== true) {
    throw new BridgeProtocolError("error.fatal must be true");
  }
  return { v: 1, k: "error", fatal: true, error: parseErrorPayload(o.error) };
}

function parseErrorPayload(x: unknown): BridgeErrorPayload {
  if (typeof x !== "object" || x === null) {
    throw new BridgeProtocolError("error payload must be an object");
  }
  const o = x as { code?: unknown; message?: unknown };
  if (typeof o.code !== "string") {
    throw new BridgeProtocolError("error.code must be a string");
  }
  if (typeof o.message !== "string") {
    throw new BridgeProtocolError("error.message must be a string");
  }
  return { code: o.code as BridgeErrorCode, message: o.message };
}

// ---------------------------------------------------------------------------
// Encoding helpers (typed → wire)
// ---------------------------------------------------------------------------

export function encodeServerFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}

export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}
