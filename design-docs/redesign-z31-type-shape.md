# tmux-control-mode-js — Type-Shape Design (`tmux-redesign-z31`)

**Status**: Authoritative. The implementing agent reads this document and implements from it.
Do NOT read existing `src/`, `tests/`, `packages/`, `examples/`, `IMPL.md`, `dist/`, or
`design-docs/pane-output-architecture.md` before implementing — those files contain the deficient
shapes this design replaces, and reading them taints judgment.

---

## 0. Why this redesign exists

Three transport-specific client classes (`TmuxClient`, `WebSocketTmuxClient`, `ElectronRendererClient`)
each own identical copies of: topology table, sink registry, epoch tracker, `bootstrapTopology()`,
`refreshWindowTopology()`, and a notification routing `if/else if` chain — roughly 240 lines of
logic duplicated verbatim three times. This violates `[LAW:one-source-of-truth]` and `[LAW:single-enforcer]`
in a way that has already produced subtle divergences between the three copies.

Additionally:
- `TmuxClientLike` is ~18 methods wide; the strongest theorem is 4–5 capabilities
- `BytesSink.end?()` is optional — the type hedges its own contract
- `BytesSink.write` receives the full wire message including discriminator fields the sink never reads
- Per-pane exclusivity registries (`attachWebSocketSink`, `attachWebContentsSink`) with `WeakMap`
  `throw-on-duplicate` logic exist for reasons that no longer apply (they have no external callers)
- The Electron bridge uses a hand-rolled `for (peer of senders)` broadcast loop instead of N
  substrate registrations (N-attachments model)
- Two race-protection mechanisms on topology (epoch tracker + per-mutator window-ownership check)
  where one clean mechanism suffices

This design eliminates all of the above. The implementing agent does NOT preserve these shapes.

---

## 1. The discriminator convention

All discriminated unions in this library use `type` (not `kind`) as the discriminant field — matching
the existing wire protocol union (`TmuxMessage`) and all existing consumer-facing types. The implementing
agent must NOT rename discriminators to `kind`.

---

## 2. ID types

Pane, window, and session IDs are `number` throughout the library. This matches the existing convention
(the parser strips the tmux sigils `%`/`@`/`$` and parses to `number`). Branded string types are
NOT introduced — the implementing agent preserves `paneId: number`, `windowId: number`, `sessionId: number`.

```ts
// These type aliases document intent but carry no branding.
type PaneId    = number;
type WindowId  = number;
type SessionId = number;
```

---

## 3. BytesSink — the byte consumer contract

```ts
/**
 * `ChunkPayload` is what the subscriber receives. The `type: 'output' | 'extended-output'`
 * discriminator has already been consumed by the substrate before dispatch. The sink receives
 * only the fields it reads.
 */
interface ChunkPayload {
  readonly paneId: number;
  readonly data: Uint8Array;
}

interface BytesSink {
  write(msg: ChunkPayload): void;
  end(): void;
}
```

**Theorem — no discriminator leak**: The tmux wire carries two pane-output message variants
(`output` and `extended-output`). The substrate consumes the discriminator and the `age` field
before dispatching to sinks. A sink receives `{ paneId, data }` — exactly the fields it reads.
`[LAW:types-are-the-program]`: the type encodes what the consumer uses, not what the wire sent.

**Theorem — `end` is total, not optional**: `BytesSink.end()` is called exactly once after the
final `write`, regardless of cause (consumer dispose, connection close, topology change). The
type does not hedge — every sink has a cleanup contract. Stateless sinks implement `end` as a no-op.
`[LAW:types-are-the-program]`: optional cleanup is the type hedging about its own contract.

**Forbids**: `type: 'output'` or `ageMs` fields on `ChunkPayload`. Optional `end?()`. Text-encoded
bytes (the `data` field is `Uint8Array` always).

**Note on the existing `PaneOutputMessage`**: The existing `BytesSink.write(msg: PaneOutputMessage)`
is the deficient shape being replaced. The implementing agent does NOT retain it. All internal
dispatch paths must be updated to pass `ChunkPayload`.

---

## 4. Scope — the subscription discriminated union

```ts
type PaneScope = { readonly type: 'pane';    readonly paneId:    number };
type WindowScope  = { readonly type: 'window';  readonly windowId:  number };
type SessionScope = { readonly type: 'session'; readonly sessionId: number };
type ServerScope  = { readonly type: 'server' };

type Scope = ServerScope | SessionScope | WindowScope | PaneScope;

// Named constructors (already exist in pane-output.ts — preserve these exports).
const serverScope: ServerScope = { type: 'server' };
function sessionScope(sessionId: number): SessionScope { return { type: 'session', sessionId }; }
function windowScope(windowId: number): WindowScope    { return { type: 'window', windowId }; }
function paneScope(paneId: number): PaneScope          { return { type: 'pane', paneId }; }
```

**Theorem — scope is a standing query, not a snapshot**: A `Scope` is evaluated per-chunk at
dispatch time against the live topology. A `sessionScope(id)` consumer sees all panes in that
session including ones added after attach. `[LAW:dataflow-not-control-flow]`: scope is data flowing
across the registry boundary, not a snapshot filter taken at attach time.

**Theorem — four arms = four tiers**: tmux's pane ontology has exactly four tiers
(server → session → window → pane). The union expresses this and nothing more.
`[LAW:types-are-the-program]`: adding a fifth tier is a new arm of this same union, not a new
`attach*` method.

---

## 5. SinkRegistry — the routing substrate

```ts
interface SinkRegistry {
  attachBytesSink(sink: BytesSink, options?: { scope?: Scope }): () => void;
}
```

**Theorem — subscription is data, not control flow**: `attachBytesSink(sink, { scope })` stores the
`(scope, sink)` pair in the registry. The registry dispatches every inbound chunk to every attached
sink whose scope matches. There is no broadcast loop in callers; there is no `if (peer.isSubscribed)`
gate at dispatch time. `[LAW:dataflow-not-control-flow]`. `[LAW:single-enforcer]`: routing lives
in exactly one place — the registry's dispatch function.

**Theorem — non-exclusive**: Multiple `attachBytesSink` calls with the same `(scope, sink)` or
different sinks at the same scope all dispatch. The registry does NOT throw on duplicate registrations.
The exclusivity registries in the existing `attachWebSocketSink` / `attachWebContentsSink` wrappers
are abolished.

**Theorem — snapshot-then-iterate**: On each inbound chunk, the registry takes a snapshot of the
current set of matching sinks before iterating. A sink that detaches during dispatch is not called
on subsequent chunks of the same batch. A sink attached during dispatch is not called for the
current chunk.

**Theorem — `end` propagation**: When `attachBytesSink` returns a disposer and the disposer is
called, the registry calls `sink.end()` exactly once. When the connection closes, every still-attached
sink receives `end()` exactly once. The registry owns this guarantee.

**Forbids**: Exclusivity checks (`throw new BridgeError('ALREADY_ATTACHED')`). Fan-out loops in
callers. Multiple dispatch (a chunk dispatched twice to the same sink). `end` called zero times or
more than once.

---

## 6. TopologyRouter — the shared substrate component

`TopologyRouter` is the key concept this redesign introduces. It is the extracted, shared substrate
that all three transport clients (local, WebSocket client, Electron renderer) **have-a** rather than
**each re-implement**.

```ts
/**
 * TopologyRouter is the complete substrate for pane-output routing: it owns the topology table,
 * the sink registry, the epoch/generation counter for race-protection, the bootstrap coordinator,
 * and the per-notification routing logic. It has zero awareness of how TmuxMessages arrive or
 * how commands depart — those are the Transport's concern.
 *
 * Every transport adapter composes a TopologyRouter rather than duplicating its logic.
 */
interface TopologyRouter {
  // Sink registration (delegates to internal SinkRegistry)
  attachBytesSink(sink: BytesSink, options?: { scope?: Scope }): () => void;

  // Topology read surface
  readonly topology: TopologySnapshot;
  onTopologyChange(listener: (snapshot: TopologySnapshot) => void): () => void;

  // Called by the transport adapter when a TmuxMessage arrives.
  // The router handles output/extended-output → dispatch, topology notifications → table update,
  // and calls back for non-topology notifications the adapter needs to emit.
  ingest(msg: TmuxMessage): void;

  // Called by the transport adapter when the transport is ready (post-handshake).
  // The router triggers topology bootstrap exactly once, guarded by generation counter.
  onTransportReady(executeCommand: (cmd: string) => Promise<CommandResponse>): void;

  // Called when the connection closes. Calls end() on all attached sinks.
  onTransportClose(): void;
}

interface TopologySnapshot {
  readonly sessions: ReadonlyMap<number, ReadonlySet<number>>; // sessionId → Set<windowId>
  readonly windows:  ReadonlyMap<number, ReadonlySet<number>>; // windowId  → Set<paneId>
  readonly panes:    ReadonlyMap<number, PaneMeta>;            // paneId    → PaneMeta
}
```

**Theorem — extracted shared substrate**: The ~240 lines of duplicated logic across the three existing
clients are replaced by one `TopologyRouter` implementation. Each transport adapter contains only
the transport-specific I/O wiring (~100–150 lines each); the substrate logic appears once.
`[LAW:one-source-of-truth]`. `[LAW:single-enforcer]`.

**Theorem — single race-protection mechanism**: `TopologyRouter` uses one generation counter
(`gen: number`) as the sole race-protection mechanism. When a full topology refresh is issued, the
current `gen` is captured. When the response arrives, the refresh is applied only if `gen` is
unchanged; otherwise it is discarded and the refresh is re-issued. This replaces the existing dual
mechanism (epoch tracker + per-window-ownership check). `[LAW:single-enforcer]`.

**Theorem — one bootstrap policy**: Bootstrap (issue `list-panes -a`, wait for response, populate
topology) is triggered exactly once per connection by `onTransportReady`. The coordinator that calls
`onTransportReady` is the transport adapter. No transport re-implements bootstrap logic.

**Forbids**: Transport adapters owning a topology table. Transport adapters owning a sink registry.
Transport adapters implementing notification routing. Two race-protection mechanisms. The implementing
agent does NOT copy bootstrapTopology / refreshWindowTopology into transport adapters.

---

## 7. TmuxConnection — the slim client interface

```ts
/**
 * TmuxConnection is the minimal capability surface that all tmux command free-functions and
 * all consumer code should accept. It has exactly five capabilities.
 *
 * [LAW:types-are-the-program] The strongest true theorem about what a consumer needs from a
 * connected tmux client is these five things. Command helpers are free functions over execute.
 */
interface TmuxConnection {
  // Execute a tmux command string. Returns the raw bytes of the response block.
  execute(command: string): Promise<CommandResponse>;

  // Subscribe to non-byte tmux notifications.
  on<K extends keyof TmuxEventMap>(event: K, listener: TmuxEventMap[K]): () => void;

  // Unsubscribe from tmux notifications.
  off<K extends keyof TmuxEventMap>(event: K, listener: TmuxEventMap[K]): void;

  // Register a byte sink.
  attachBytesSink(sink: BytesSink, options?: { scope?: Scope }): () => void;

  // Read the current connection state.
  readonly connectionState: ConnectionState;
}
```

**Theorem — free functions over `execute`**: Every tmux command (`list-panes`, `send-keys`,
`split-window`, etc.) is a free function `(conn: TmuxConnection, ...args): Promise<Result>`. There
are NO per-command methods on `TmuxConnection`. The existing `TmuxClient.listWindows()`,
`.sendKeys()`, `.splitWindow()` etc. are all moved to free functions. The connection interface has
exactly five entries. `[LAW:one-type-per-behavior]`: one dispatch primitive, not N command-shaped
methods.

**Forbids**: Per-command methods on this interface. An 18-method `TmuxClientLike`. Consumers who
depend on the full `TmuxClient` class when they only need `execute` + `attachBytesSink`.

---

## 8. TmuxClient — the concrete class

`TmuxClient` is the class that implements `TmuxConnection` plus lifecycle. It composes a
`TopologyRouter` and a `Transport`. It is instantiated once per connection and used for all three
transport variants.

```ts
class TmuxClient implements TmuxConnection {
  constructor(transport: Transport) { /* ... */ }

  // TmuxConnection implementation
  execute(command: string): Promise<CommandResponse>;
  on<K extends keyof TmuxEventMap>(event: K, listener: TmuxEventMap[K]): () => void;
  off<K extends keyof TmuxEventMap>(event: K, listener: TmuxEventMap[K]): void;
  attachBytesSink(sink: BytesSink, options?: { scope?: Scope }): () => void;
  readonly connectionState: ConnectionState;

  // Lifecycle (not on TmuxConnection — callers who attach sinks don't need this)
  close(): Promise<void>;

  // Topology read surface for consumers who need to observe topology directly.
  // Exposed here for convenience; routes to the internal TopologyRouter.
  readonly topology: TopologySnapshot;
  onTopologyChange(listener: (snapshot: TopologySnapshot) => void): () => void;
}
```

**Theorem — one class for all transports**: The three existing classes (`TmuxClient`,
`WebSocketTmuxClient`, `ElectronRendererClient`) collapse to one `TmuxClient` class. Transport
variance is fully expressed by the `Transport` interface (§9). `[LAW:one-source-of-truth]`.
`[LAW:one-type-per-behavior]`.

---

## 9. Transport interface

```ts
/**
 * Transport is the I/O seam. It delivers parsed TmuxMessages to the substrate and accepts
 * command strings from the substrate. The substrate has zero awareness of how bytes arrive
 * or depart; the transport has zero awareness of topology, sinks, or command correlation.
 *
 * [LAW:locality-or-seam]: TmuxMessage is the seam. Parser belongs to the transport; substrate
 * logic belongs to TopologyRouter / TmuxClient.
 */
interface Transport {
  readonly ready: Promise<TmuxVersion>;

  // Deliver parsed messages into the substrate.
  onMessage(handler: (msg: TmuxMessage) => void): () => void;
  onClose(handler: (reason: ConnectionState & { phase: 'closed' }) => void): () => void;

  // Accept command strings from the substrate (write to tmux stdin / WS / IPC).
  send(commandLine: string): void;

  close(): Promise<void>;
}

type TmuxVersion = { readonly major: number; readonly minor: number; readonly suffix: string | null };
```

**Theorem — parser belongs to the transport**: The local transport (spawn `tmux -C`) parses
tmux's text wire into `TmuxMessage` objects. The WS client transport decodes the binary/JSON bridge
frames into `TmuxMessage` objects. The Electron renderer transport unwraps structured-clone
envelopes into `TmuxMessage` objects. Each transport produces `TmuxMessage`s; the substrate
(`TmuxClient` / `TopologyRouter`) only processes them.

**Three transport constructors**:

```ts
// Node-only. Spawns tmux -C.
function createLocalTransport(options?: SpawnOptions): Transport;

// Browser and Node. Connects to a WS bridge server.
function createWebSocketClientTransport(opts: {
  url: string | URL;
  reconnect?: ReconnectPolicy;
}): Transport;

// Electron renderer process only.
function createElectronRendererTransport(opts: {
  channel: string;
  ipcRenderer?: IpcRendererLike; // injectable for testability
}): Transport;
```

**Forbids**: Substrate logic (topology, registry, bootstrap, correlation) inside any transport.
A transport that exposes raw bytes instead of parsed `TmuxMessage`s. Transport-specific client
subclasses.

---

## 10. CommandResponse

```ts
// Unchanged from the existing definition. Byte-faithful: output is Uint8Array.
type CommandResponse =
  | { readonly ok: true;  readonly output: Uint8Array }
  | { readonly ok: false; readonly output: Uint8Array };
```

**Theorem — byte-faithful**: Command output (e.g. `capture-pane -p`) is delivered as raw bytes.
The substrate does NOT text-decode command responses. `[LAW:one-source-of-truth]`: the existing
`byte-codec.ts` / `latin1ToBytes` contract (ticket `xxj.4`) is preserved.

**Theorem — FIFO correlation, no ID field**: tmux processes commands in send order and replies in
send order. The correlator is a FIFO queue of `Promise` resolvers; the next `%begin`/`%end`/`%error`
block resolves the head. No `id` field is added to outbound commands. `[LAW:types-are-the-program]`:
FIFO is the only correct shape; an id-based correlator would be a lie about the protocol.
`[LAW:no-defensive-null-guards]`: no defensive branch for "what if a notification arrives mid-block"
— the protocol forbids it (SPEC_MANIFEST §4).

---

## 11. ConnectionState

```ts
type ConnectionState =
  | { readonly phase: 'connecting' }
  | { readonly phase: 'ready';   readonly version: TmuxVersion }
  | { readonly phase: 'closing' }
  | { readonly phase: 'closed';  readonly reason: ExitReason };

type ExitReason =
  | { readonly type: 'detached' }
  | { readonly type: 'server-exit' }
  | { readonly type: 'transport-error'; readonly cause: Error }
  | { readonly type: 'transport-closed' }
  | { readonly type: 'explicit-close' };
```

**Theorem — one-way state machine**: `connecting → ready → closing → closed`. No back edges.
"Did we close, and why" is a structural match on `phase === 'closed'`, not a separate boolean plus
an optional error. `[LAW:types-are-the-program]`.

---

## 12. TmuxEventMap — pane bytes excluded at the type level

```ts
// Pane byte messages are excluded from the emitter's type surface.
// client.on('output', ...) is a compile error; bytes flow only through attachBytesSink.
// [LAW:make-it-impossible]
type EmitterMessage = Exclude<TmuxMessage, { type: 'output' } | { type: 'extended-output' }>;

interface TmuxEventMap {
  'message': (msg: EmitterMessage) => void;
  'state':   (state: ConnectionState) => void;
}
```

**Theorem**: Subscribing to pane bytes via the event emitter is a **compile-time error**. The type
excludes `output` and `extended-output` arms. `[LAW:make-it-impossible]`. The footgun (reaching for
`client.on('output', ...)` instead of `attachBytesSink`) is abolished at the type level.

---

## 13. Bridge server — N-attachments model

A bridge server wraps a local `TmuxClient` and serves N remote peers. **Bytes are routed by the
substrate's `SinkRegistry`**, not by a broadcast loop in the bridge.

```ts
/**
 * PeerSink bridges one peer's byte subscription into the substrate's registry.
 * It is ONE BytesSink per peer, attached with the peer's chosen Scope.
 *
 * [LAW:dataflow-not-control-flow]: N peers = N substrate registrations.
 * There is no for-loop over peers in the bridge's byte-dispatch path.
 */
function createPeerByteSink(opts: {
  sendFrame: (frame: BinaryFrame) => void;
  backpressure: BackpressureController;
}): BytesSink;
```

**The existing deficiency being eliminated**: The Electron bridge currently has one `forwardBytes`
`BytesSink` that does `for (const wc of this.senders) { if (wc is subscribed) wc.send(encode(msg)) }`.
This is a control-flow broadcast loop inside a sink — the anti-pattern that `[LAW:dataflow-not-control-flow]`
forbids. The replacement: each peer registers its own `BytesSink` via `client.attachBytesSink(peerSink, { scope: peerScope })`. The substrate routes. The bridge does not iterate peers.

**Wire format** (binary frames for both WS and Electron IPC):

```
byte 0:     magic = 0x02  (pane output frame marker)
bytes 1–4:  paneId as big-endian uint32
bytes 5–N:  raw pane bytes verbatim (Uint8Array, never text-encoded)
```

JSON text frames carry all other messages (topology notifications, command responses, heartbeats).
`[LAW:one-source-of-truth]`: one wire format spec, used by both WS and Electron bridges.

---

## 14. Backpressure (WS bridge)

```ts
interface BackpressureController {
  // Called after every outbound byte frame — samples bufferedAmount on the channel.
  // [LAW:single-enforcer]: every outbound frame samples drain, not just byte writes.
  onBytesSent(paneId: number, channelBufferedAmount: number): void;

  // Fires when the substrate should pause or resume a pane.
  onDecision(listener: (d: BackpressureDecision) => void): () => void;
}

type BackpressureDecision =
  | { readonly type: 'pause';    readonly paneId: number }
  | { readonly type: 'continue'; readonly paneId: number };
```

**Key invariant**: `onBytesSent` must be called for EVERY outbound frame (including event frames,
heartbeats, topology updates), not only pane-byte frames. A slow receiver whose buffer is growing
still gets the `continue` signal after drain even if no byte frames are queued. Sampling only byte
writes (the existing deficiency) makes drain detection unreliable.

---

## 15. Free-function command surface

All tmux commands are free functions. NONE of them appear as methods on `TmuxConnection`.

```ts
// Each function calls conn.execute(buildCommandString(args)) and parses the output.
function listSessions(conn: TmuxConnection): Promise<readonly SessionInfo[]>;
function listWindows(conn: TmuxConnection, options?: ListWindowsOptions): Promise<readonly WindowInfo[]>;
function listPanes(conn: TmuxConnection, options?: ListPanesOptions): Promise<readonly PaneInfo[]>;
function sendKeys(conn: TmuxConnection, target: number, keys: readonly string[]): Promise<void>;
function splitWindow(conn: TmuxConnection, options?: SplitOptions): Promise<number>;
function setSize(conn: TmuxConnection, width: number, height: number): Promise<void>;
function setPaneAction(conn: TmuxConnection, paneId: number, action: PaneAction): Promise<void>;
function subscribeFormat(conn: TmuxConnection, sub: FormatSubscription): Promise<void>;
function unsubscribeFormat(conn: TmuxConnection, name: string): Promise<void>;
function requestReport(conn: TmuxConnection, paneId: number, report: TerminalReport): Promise<void>;
```

**Theorem**: Every command is `execute(buildCommandString(args))` where `buildCommandString` is a
pure string formatter. Adding a new command is one new function in `commands/`. No interface edit.
No transport edit. `[LAW:one-type-per-behavior]`. `[LAW:no-mode-explosion]`.

---

## 16. What this design forbids — summary

| Forbidden pattern | Replaced by |
|---|---|
| Three transport-specific client classes each owning topology + registry + bootstrap + notification routing | One `TmuxClient` class composing `TopologyRouter` + `Transport` |
| ~18-method `TmuxClientLike` interface | `TmuxConnection` with 5 methods; command helpers are free functions |
| `BytesSink.end?()` optional | `BytesSink.end()` total, unconditional |
| `BytesSink.write(msg: PaneOutputMessage)` with discriminator fields | `BytesSink.write(msg: ChunkPayload)` — only `{ paneId, data }` |
| Per-pane attacher wrappers with `WeakMap` exclusivity + `throw` on duplicate | `SinkRegistry.attachBytesSink` non-exclusive by construction |
| Electron bridge hand-rolled broadcast loop `for (peer of senders)` | N substrate registrations via `attachBytesSink`; registry routes |
| Dual race-protection (epoch tracker + window-ownership check) | Single `gen` counter in `TopologyRouter.bootstrap` |
| Pane bytes reachable via event emitter | `EmitterMessage = Exclude<TmuxMessage, {type:'output'}\|{type:'extended-output'}>` |
| `kind` as discriminant | `type` as discriminant (existing convention) |

---

## 17. Composition graph

```
createLocalTransport(opts)             → Transport
createWebSocketClientTransport(opts)   → Transport
createElectronRendererTransport(opts)  → Transport

TmuxClient(transport: Transport)
  ├── internal: TopologyRouter          ← [LAW:one-source-of-truth] one instance, shared
  │     ├── SinkRegistry               ← routes chunks to BytesSink registrations
  │     ├── TopologyTable (gen-gated)  ← one race-protection mechanism
  │     └── bootstrap coordinator      ← triggers once on transport-ready
  ├── internal: CommandCorrelator      ← FIFO queue, no id field
  ├── internal: ConnectionStateMachine
  └── internal: EventEmitter<TmuxEventMap>  ← pane bytes excluded by type

Free command functions (listPanes, sendKeys, …)
  └── only need: TmuxConnection.execute + TmuxConnection.attachBytesSink

BridgeServer (WS or Electron)
  ├── wraps: TmuxClient (local transport)
  └── per peer:
        ├── PeerByteSink  → client.attachBytesSink(peerSink, { scope: peerScope })
        ├── BackpressureController
        └── event/topology forwarding from client.on('message', ...) → peerChannel.send(...)

One-way dependency order:
protocol → topology → registry → TopologyRouter → TmuxClient → transport adapters → bridge
commands/ depends only on TmuxConnection (the slim interface)
```

---

## 18. Module layout (target)

```
src/
  protocol/           — pure: TmuxMessage union, parser, encoder, octal codec, command builders
  pane-output.ts      — BytesSink, Scope, SinkRegistry, PaneMeta, scope constructors
                        (existing file; shapes updated per §3–§5 above)
  client.ts           — TmuxClient, TmuxConnection, TopologyRouter, ConnectionStateMachine,
                        CommandCorrelator, TmuxEventMap, EmitterMessage
                        (replaces the three existing transport-specific client classes)
  transport/
    spawn.ts          — createLocalTransport (Node-only)
    types.ts          — Transport interface, TmuxVersion, SpawnOptions
    sockets.ts        — tmuxSocketDir, listTmuxSocketNames, isTmuxServerAlive (unchanged)
  commands/           — free functions: listSessions, listWindows, listPanes, sendKeys,
                        splitWindow, setSize, setPaneAction, subscribeFormat, requestReport, …
  connectors/
    websocket/
      client.ts       — createWebSocketClientTransport
      server.ts       — createWebSocketBridgeServer (N-attachments model)
      protocol.ts     — encodePaneOutput, decodePaneOutput, WireFrame codec (binary format §13)
    electron/
      main.ts         — createElectronMainBridgeServer (N-attachments model)
      renderer.ts     — createElectronRendererTransport
  sinks/
    text-stream.ts    — createTextStreamSink (existing, unchanged)
  line-sink.ts        — attachLineSink (existing; updated to use new ChunkPayload shape)
  index.ts            — public API exports only
```

**Subpath exports** (target `package.json`):

```json
{
  ".":                      "./dist/index.js",
  "./protocol":             "./dist/protocol/index.js",
  "./websocket/client":     "./dist/connectors/websocket/client.js",
  "./websocket/server":     "./dist/connectors/websocket/server.js",
  "./electron/main":        "./dist/connectors/electron/main.js",
  "./electron/renderer":    "./dist/connectors/electron/renderer.js"
}
```

---

## 19. The 14 must-preserve domain truths — how the design absorbs each

| # | Truth | Design enforcement |
|---|---|---|
| 1 | Byte fidelity — no text encoding on the pane-byte path | `ChunkPayload.data: Uint8Array`; no string constructor for `BytesSink` |
| 2 | Stateful UTF-8 decode across chunk boundaries; shared decoder per pane | `attachLineSink` uses one `TextDecoder({ stream: true })` per pane, shared across all line consumers; message-object identity check prevents double-decode |
| 3 | Notifications never appear inside `%begin`/`%end` blocks | `CommandCorrelator` treats all non-terminator lines inside a block as `response-line` with no defensive branch — the protocol invariant is trusted |
| 4 | FIFO command correlation; no id field on outbound commands | `CommandCorrelator` is a queue; `execute` has no id parameter |
| 5 | Topology race: sync notifications can arrive before async full-refresh response | Single `gen` counter in `TopologyRouter`; bootstrap captures gen, applies only if gen unchanged |
| 6 | WS backpressure: sample bufferedAmount on EVERY outbound frame, not just byte writes | `BackpressureController.onBytesSent` called from the single `peerChannel.send` chokepoint |
| 7 | Wire encoding: pane bytes are bytes on the wire (magic-byte binary frame, not base64) | Binary frame format documented in §13; `Uint8Array` throughout |
| 8 | Topology bootstrap: idempotent, race-safe, triggered by need | `TopologyRouter.onTransportReady` triggers once; gen-gated response application; second call with stale gen is no-op |
| 9 | Pane bytes must not be reachable via the event emitter | `EmitterMessage = Exclude<TmuxMessage, {type:'output'}\|{type:'extended-output'}>` — compile error to subscribe |
| 10 | tmux version floor 3.2; gated higher features at call sites | `ConnectionState.ready.version` carries `TmuxVersion`; `requestReport` checks at its entry |
| 11 | Zero runtime dependencies | `package.json` has no `dependencies`; `scripts/check-no-deps.mjs` gate preserved |
| 12 | Published package ships `dist/` only | `"files": ["dist"]` preserved |
| 13 | Out-of-order window-refresh monotonicity | `gen` counter; `replace-window` update no-ops if window no longer in topology |
| 14 | Line-sink lifecycle: final flush on detach, CRLF strip, decoder drop | `attachLineSink`'s `end()` flushes partial line through `onLine` exactly when last admitting consumer detaches, then drops decoder |

---

## 20. Named tests required (ticket `tmux-redesign-z31.8`)

The implementing agent must produce a test file `tests/unit/redesign-laws.test.ts` with one
`describe` block per item below. These are the 14 domain truths plus critical structural properties:

1. `byte-fidelity` — `BytesSink.write` is called with raw bytes; a `string` argument is a
   compile-time error (enforce via `@ts-expect-error`)
2. `shared-decoder` — two line consumers attached at overlapping scope decode one stream; the
   decoder is called once per chunk regardless of consumer count
3. `block-purity` — a `%output`-shaped line arriving inside a `%begin`/`%end` block is treated as
   `response-line`, not dispatched as a notification
4. `fifo-correlation` — two commands sent in sequence resolve in send order; no id field on the
   send wire
5. `topology-race` — a full-refresh response with a stale gen token is discarded; a subsequent
   notification that arrived before the response takes effect
6. `backpressure-all-frames` — drain detection fires when non-byte event frames drain the
   channel buffer, not only when byte frames drain
7. `wire-bytes-not-text` — the binary frame format encodes paneId as uint32 + raw Uint8Array;
   no base64 / text encoding path exists
8. `bootstrap-idempotent` — two concurrent session-scope attaches with the same client trigger
   exactly one `list-panes -a` bootstrap command
9. `emitter-excludes-bytes` — `client.on('message', n => n.type === 'output')` is a compile-time
   error (`@ts-expect-error`)
10. `version-floor` — `requestReport` on a client reporting tmux < 3.5 fails with a documented
    error; the substrate does not crash
11. `no-broadcast-loop` — the WS bridge and Electron bridge have no `for (peer of peers)` byte-
    dispatch loop; each peer is a `BytesSink` in the substrate registry
12. `non-exclusive-registry` — two `attachBytesSink` calls at the same scope both receive chunks;
    no `ALREADY_ATTACHED` error is thrown
13. `end-is-total` — disposing an attachment calls `sink.end()` exactly once; closing the
    connection calls `end()` on all remaining sinks exactly once each
14. `decoder-drain-on-detach` — disposing the last line consumer for a pane flushes any partial
    line through `onLine`; no bytes are lost

---

## End of design document

The implementing agent reads this document and implements from it. The deliverable sequence is:

1. ~~Type-shape design document~~ **← this document**
2. Substrate: `TopologyRouter`, `SinkRegistry`, updated `BytesSink`/`Scope`, `CommandCorrelator`,
   `ConnectionStateMachine`, `TmuxClient` (one class), `attachLineSink` update
3. Local transport adapter: `createLocalTransport` (thin wrapper over existing spawn logic)
4. WebSocket transport adapters: `createWebSocketClientTransport` + `createWebSocketBridgeServer`
   (N-attachments model)
5. Electron IPC transport adapters: `createElectronRendererTransport` + `createElectronMainBridgeServer`
   (N-attachments model)
6. In-tree consumer migration: update `line-sink.ts`, `sinks/text-stream.ts`,
   `packages/pane-terminal/`, `examples/web-multiplexer/`
7. Delete old implementation: remove the three old client classes, remove exclusivity wrappers,
   remove broadcast loop
8. Hard-won-lessons named test suite (the 14 tests in §20)
