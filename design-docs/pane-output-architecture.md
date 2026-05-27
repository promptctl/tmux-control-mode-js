# Pane Output Architecture — design

**Status:** design.
**Date:** 2026-05-27.
**Scope:** rearchitects the pane-output subscription API around two
consumer behaviors (bytes / lines) and a scope-based subscription
axis. Supersedes the per-pane / all-panes split from
`tmux-pane-sink-hd6` (PRs #51–#57).

---

## Why this exists

This library exists because the first downstream consumer of an
earlier byte-shaped API mis-decoded `Uint8Array` payloads with
`new TextDecoder('latin1').decode(...)` and shipped mojibake on every
non-ASCII pane. Subtle escape-sequence and cursor-positioning bugs
followed. The fix shipped in PR #57 (removing pane-byte messages from
the emitter type surface) was structurally correct but exposed two
remaining problems:

1. **The "common case is a single pane" assumption is wrong.** Every
   real consumer we've seen — internal demo, prospective external
   consumers — works at the level of "this session," "this window,"
   or "the whole tmux server." The single-pane API forced bookkeeping
   onto consumers that the library should own.

2. **Bytes are still too easy to reach.** The previous API exposed
   `PaneByteSink` as a Tier-2 surface anyone could compose with.
   Authors writing matchers / loggers / search code reached for bytes
   because they were available, then re-implemented streaming UTF-8
   decode (badly).

This design closes both. The new public surface has exactly two
consumer behaviors; consumers who want text get lines, consumers
who want bytes write a `BytesSink` (explicit opt-in); subscriptions
target scopes (server / session / window / pane), not individual
panes; topology changes are handled by the library, not the consumer.

---

## The two consumer behaviors

```ts
// Line-shaped — the default for matchers, loggers, search, AI context
// capture, assertions, anything string-shaped.
function attachLineSink(
  client: TmuxClientLike,
  onLine: (event: { line: string; paneId: number }) => void,
  options?: AttachOptions,
): () => void;

// Byte-shaped — for terminal renderers, transport forwarders,
// byte-faithful archival. The sink is byte-aware; the consumer
// authoring the sink owns the byte handling.
function attachBytesSink(
  client: TmuxClientLike,
  sink: BytesSink,
  options?: AttachOptions,
): () => void;

interface BytesSink {
  write(msg: PaneOutputMessage): void;
  end?(): void;
}
```

That's the entire public surface for pane output. Two behaviors.
Different shapes, because they're different behaviors:

- **Lines** are stream-shaped. `onLine` receives one complete line at
  a time, no trailing newline. The library decodes UTF-8 statefully
  across chunks (shared per-pane `TextDecoder({ stream: true })`),
  splits on newline, and buffers partial lines until the next chunk
  completes them. On detach, any buffered text in the line splitter
  is flushed as a final `onLine` call.

- **Bytes** are chunk-shaped. `write(msg)` receives one wire chunk at
  a time. Chunks do not align with anything semantic: a UTF-8
  multi-byte sequence may straddle two chunks; an ANSI escape may; a
  log line may. The implementer is responsible for stream-aware byte
  handling. Used when the destination IS byte-aware (a terminal
  renderer, a binary wire frame, a byte archive).

[LAW:one-type-per-behavior] These two behaviors are genuinely
different: text-stream consumption versus byte-stream consumption.
Two contracts, two methods, two argument shapes. They are not
"different views of one thing" and cannot be unified without making
one of them dishonest about what the consumer holds.

---

## BytesSink — one contract, many implementations

The library ships several pre-built `BytesSink` implementations for
common destinations:

```ts
class XtermSink implements BytesSink {
  constructor(term: TerminalLike);
  write(msg: PaneOutputMessage): void;  // term.write(msg.data)
}

class WebSocketSink implements BytesSink {
  constructor(ws: WebSocketLike);
  write(msg: PaneOutputMessage): void;  // ws.send(encodePaneOutput(msg))
}

class WebContentsSink implements BytesSink {
  constructor(wc: WebContentsLike);
  write(msg: PaneOutputMessage): void;  // wc.send(IPC.event, msg)
}
```

Plus convenience attachers — pure sugar that composes
`attachBytesSink` with a fresh sink instance:

```ts
attachXtermSink(client, term, options?)
  ≡ attachBytesSink(client, new XtermSink(term), options)

attachWebSocketSink(client, ws, options?)
  ≡ attachBytesSink(client, new WebSocketSink(ws), options)

attachWebContentsSink(client, wc, options?)
  ≡ attachBytesSink(client, new WebContentsSink(wc), options)
```

A user-authored sink (e.g., a next-gen terminal renderer replacing
xterm.js, or an archival sink writing bytes to disk) takes exactly
the same shape: `class MyRenderer implements BytesSink`. The library
does not distinguish "library-shipped" from "user-authored" sinks at
the type level — both are `BytesSink`.

[LAW:single-enforcer] There is one byte-consumption contract:
`BytesSink`. Every implementation — library or user — speaks it.
Adding a fifth pre-built sink is one new class plus a one-line
convenience factory; the library's dispatch path does not change.

[LAW:no-mode-explosion] The convenience attachers do not create new
modes. They are factories that compose one canonical method
(`attachBytesSink`) with one canonical type (`BytesSink`).

---

## PaneScope — the subscription axis

The set of panes a consumer is interested in is encoded as a tagged
union, not as a paneId filter:

```ts
type PaneScope =
  | { readonly kind: "server" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "window"; readonly windowId: string }
  | { readonly kind: "pane"; readonly paneId: number };

interface AttachOptions {
  readonly scope?: PaneScope;  // default: serverScope
}

// Factory functions — what consumers reach for
const serverScope: PaneScope;
function sessionScope(sessionId: string): PaneScope;
function windowScope(windowId: string): PaneScope;
function paneScope(paneId: number): PaneScope;
```

Each scope is a **standing query** against the tmux topology, not a
snapshot of currently-matching panes. Membership is re-checked at
chunk-arrival time; topology changes propagate automatically without
the consumer re-subscribing.

### Scope semantics

| Scope | Initial set | New session | Pane added to scope | Pane removed from scope | Pane closes |
|---|---|---|---|---|---|
| `server` | every pane on the tmux server | new panes auto-included | n/a | n/a | dropped |
| `session($N)` | panes currently in $N | NOT included | new pane created in $N's window → included | window unlinks from $N → excluded | dropped |
| `window(@N)` | panes currently in @N | n/a | pane created in @N → included | pane moves to another window → excluded | dropped |
| `pane(%N)` | %N (if it exists) | n/a | n/a | n/a | dropped, never returns |

Cross-scope rules:

- A pane that is admitted by multiple scopes (e.g., both
  `serverScope` and a specific `sessionScope`) is delivered to every
  matching attachment, once per attachment, not once per scope.
- Pane moves between sessions (`move-window`,
  `%window-pane-changed`) update topology, and the next chunk's
  dispatch sees the new membership. Already-delivered bytes are not
  retroactively unsubscribed.
- The default scope is `serverScope`. Consumers who don't specify a
  scope are subscribing to the whole tmux server, including future
  sessions and panes.

[LAW:one-type-per-behavior] All four scope kinds are arms of one
discriminated union. They are not four methods, four sink types, or
four attach surfaces. Adding a fifth scope (e.g.,
`sessionNameScope("work-*")`) is a new arm, not a new method.

[LAW:dataflow-not-control-flow] The "is this pane in scope" answer
lives in data (topology table + scope description), not in
pre-computed control flow. Topology changes update the table; the
next chunk reads it.

---

## PaneTopology — the membership table

The library maintains one in-memory table:

```ts
type PaneMeta = { sessionId: string; windowId: string };
type PaneTopology = Map<number, PaneMeta>;
```

Kept current by consuming the same tmux notifications the emitter
already delivers: `%window-add`, `%window-close`,
`%window-pane-changed`, `%session-changed`,
`%unlinked-window-close`, `%layout-change`, etc. The topology layer
is the sole writer to this table; every scope-admission check is
the sole reader.

[LAW:one-source-of-truth] Pane membership has exactly one
authoritative representation. Consumer-visible APIs (`listPanes`,
`listWindows`) remain as on-demand snapshots from tmux; the topology
table is the library's internal real-time view for dispatch.

### Topology bootstrap

A fresh `TmuxClient` knows no topology. On connect, the library
invokes `list-sessions`, `list-windows -a`, and `list-panes -a` to
seed the table. From that point forward, notifications keep it
current.

Bytes that arrive for a paneId not yet known to topology (a tmux
notification race) are dispatched as if the pane belonged to no
session or window — `paneScope` for that ID matches; `serverScope`
matches; `sessionScope` and `windowScope` do not. The next topology
update (which races behind the byte) populates the table; subsequent
bytes for that pane resolve correctly.

---

## SinkRegistry — scope-bifurcated dispatch

The internal registry stores attachments by scope kind:

```
SinkRegistry:
  serverAttachments:   Set<Attachment>
  sessionAttachments:  Map<sessionId, Set<Attachment>>
  windowAttachments:   Map<windowId, Set<Attachment>>
  paneAttachments:     Map<paneId, Set<Attachment>>
```

Dispatch for paneId X:

```
1. meta = topology.get(X)
2. paneSet     = paneAttachments.get(X)
3. windowSet   = meta && windowAttachments.get(meta.windowId)
4. sessionSet  = meta && sessionAttachments.get(meta.sessionId)
5. serverSet   = serverAttachments
6. For each non-empty set, snapshot iterate and call attachment.write(msg).
```

Cost per chunk: O(matching attachments across the four buckets).
Storage cost: same as PR #57 plus the topology table (one entry per
pane). No allocation on the no-consumer path (every bucket lookup
returns undefined or empty).

[LAW:dataflow-not-control-flow] The dispatch path runs the same
shape on every chunk regardless of which scopes have admitting
attachments. Variance lives in which buckets are non-empty.

---

## Line pipeline — shared per-pane decode

Each pane that has at least one line-shaped attachment whose scope
admits it gets a `LinePipeline` instance:

```
LinePipeline (per paneId, lazy):
  decoder:    TextDecoder({ stream: true })
  buffer:     string  // partial trailing line
  consumers:  Set<(event: { line, paneId }) => void>
```

Lifecycle:

- **First attachment whose scope admits paneId X** → create
  `LinePipeline` for X.
- **Last such attachment detaches** → flush decoder
  (`decoder.decode()` with no `{ stream: true }`), flush partial
  line buffer through consumers, drop the pipeline.

Dispatch:

```
1. For each chunk on paneId X:
   - text = pipeline.decoder.decode(msg.data, { stream: true })
   - pipeline.buffer += text
   - split pipeline.buffer on '\n'; everything except the last
     element is a complete line; the last is the new buffer
   - for each complete line: for each consumer: consumer({ line, paneId })
```

If N line consumers exist for one pane regardless of scope (one
`paneScope`, two `sessionScope`, one `serverScope`), the decoder
runs ONCE per chunk. The resulting lines are fanned out to all N
consumers by reference. No redundant decoding.

[LAW:single-enforcer] Per-pane streaming decode lives in exactly
one place. Consumers do not author decoders; consumers do not see
chunk boundaries. The decoder owns the cross-chunk multi-byte
state.

[LAW:dataflow-not-control-flow] The pipeline is lazy: it exists iff
at least one admitting consumer exists. No idle-pane work; no idle
decoder.

---

## Idle pane suppression (future, opt-in)

The registry exposes two internal lifecycle hooks:

```
onPaneBecameInteresting(paneId)  fires when total admitting attachments
                                 for paneId transitions 0 → 1
onPaneBecameIdle(paneId)         fires when total admitting attachments
                                 for paneId transitions 1 → 0
```

A future `IdlePaneSuppressor` listens to these hooks and calls
`client.setPaneAction(paneId, PaneAction.Pause | PaneAction.Continue)`
to suppress tmux byte emission for idle panes.

`refresh-client -C pause-pane / continue-pane` is per-control-mode-
client. The suppressor pauses only THIS client's view; other tmux
clients attached to the same session are unaffected.

This is opt-in via constructor option. Default off → simpler shipping;
opt-in flips on the layer. The consumer-facing API is unchanged
either way; only tmux-side traffic shifts.

---

## What's removed

- `attachPaneSink(paneId, sink)` — replaced by `attachBytesSink` with
  `paneScope(paneId)`.
- `attachAllPanesSink(mux)` — replaced by `attachBytesSink` with
  `serverScope` (default).
- `PaneByteSink` interface (the `write(bytes)` shape) — replaced by
  `BytesSink` (`write(msg)`).
- `PaneByteMultiplexer` — collapsed into `BytesSink`.
- `createTextStreamSink` — replaced by `attachLineSink` for the
  default text path. Character-streaming text remains available via
  a user-authored `BytesSink` if needed; a future Tier-1
  `attachTextStreamSink` may be added if a real consumer requires
  character-granular text.

---

## Implementation order

Steel-thread-and-expand. Each increment is end-to-end and
integration-tested against an ephemeral tmux server before the next
one starts.

1. **Substrate + scope dispatch (steel thread).** `BytesSink`,
   `attachBytesSink`, `PaneScope` union + factories, `PaneTopology`,
   `SinkRegistry` scope bifurcation. All four scopes ship together.
   Integration tests against ephemeral tmux exercise every scope
   variant, including topology mutations (new sessions, new windows,
   pane moves between windows, pane closes).

2. **Line pipeline.** `attachLineSink` + shared per-pane decoder +
   line buffer + flush semantics. Integration tests cover scope
   variants (per-pane, per-session, per-window, server-wide), cross-
   chunk UTF-8, cross-chunk line boundaries, and multiple line
   consumers sharing one decoder.

3. **BytesSink destinations.** `XtermSink`, `WebSocketSink`,
   `WebContentsSink` as `BytesSink` classes. Convenience attachers.
   Migrate existing in-tree usages (library bridges, demo bridges,
   tests).

4. **Demo migration.** Replace the web-multiplexer demo's per-byte
   forwarding code with the new public destinations. Playwright e2e
   tests stay green. Supersedes `tmux-pane-sink-hd6.7`.

5. **(Future, opt-in) Idle pane suppression.** Hooks + suppressor.

---

## Architectural laws engaged

- **`[LAW:types-are-the-program]`** — the strongest true theorem
  about what flows is "a parsed pane-output message" (for byte
  consumers) and "a line of text" (for line consumers). Two shapes,
  two consumer behaviors. The previous unified-on-bytes design was
  weaker because it forced line consumers to author byte handling.

- **`[LAW:one-type-per-behavior]`** — two consumer behaviors → two
  attach methods + two contracts. The four scope kinds are arms of
  one union, not four methods. `BytesSink` is one interface, not
  N variants per destination.

- **`[LAW:dataflow-not-control-flow]`** — pane membership is data
  (topology table + scope description); scope admission is a
  per-chunk lookup, not pre-computed at attach time. Topology
  changes propagate as data updates; dispatch path is unchanged.

- **`[LAW:single-enforcer]`** — one byte-consumption contract
  (`BytesSink`), one per-pane decoder (in `LinePipeline`), one
  topology table (`PaneTopology`), one dispatch path
  (`SinkRegistry.dispatch`).

- **`[LAW:one-source-of-truth]`** — `PaneTopology` is the
  authoritative real-time pane-membership view, kept current from
  one notification stream. `PaneScope` factories produce values
  that flow through the same attach boundary; scope-related code
  exists nowhere outside the union and its dispatch consumers.

- **`[LAW:no-mode-explosion]`** — N pre-built sinks + N convenience
  attachers do not create N modes. They are values composing one
  method (`attachBytesSink`) with one contract (`BytesSink`).

- **`[LAW:locality-or-seam]`** — `BytesSink` and the line callback
  are the seams between library and consumer. The consumer never
  crosses into library territory (no parser access, no registry
  access). The library never crosses into consumer territory (no
  decode policy choice, no scope-related bookkeeping for the
  consumer).

- **`[LAW:make-it-impossible]`** — `attachLineSink` consumers
  CANNOT misdecode bytes because they never hold any. The friction
  required to reach bytes (implement `BytesSink`) is the signal
  that this is the byte-aware path.
