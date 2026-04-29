# Implementation Plan

Architecture, rationale, and recommendations for `tmux-control-mode-js`.

Primary target: Electron app. Secondary: any Node.js application, with the
protocol layer reusable in browser environments behind a WebSocket relay.

---

## 1. Why TypeScript

The tmux control mode protocol has well-defined, enumerable message types. Each
notification (`%output`, `%window-add`, `%session-changed`, etc.) has a
distinct argument shape. TypeScript gives us:

- **Discriminated unions for messages.** A parsed message is
  `{ type: "output", paneId: number, data: Uint8Array }` or
  `{ type: "window-add", windowId: number }` — never an ambiguous bag of
  strings. Consumers get exhaustive `switch` statements and autocomplete.

- **Type-safe event emitters.** The event map is finite and known at compile
  time. `client.on("window-add", (ev) => ...)` should autocomplete `ev` fields.

- **Protocol correctness at the boundary.** The parser is a trust boundary
  (external data in). Types document what the parser guarantees to downstream
  code, making it clear where validation ends and trusted internal data begins.

- **Zero runtime cost.** Types erase at build time. The output is plain JS with
  no runtime dependency on TypeScript.

---

## 2. Package Structure

Two logical layers, shipped as a single package with separate entry points:

```
tmux-control-mode-js/
├── src/
│   ├── protocol/          # Pure protocol layer (no Node.js APIs)
│   │   ├── types.ts       # Message types, discriminated unions, enums
│   │   ├── parser.ts      # Line-oriented protocol parser
│   │   ├── encoder.ts     # Command string builder
│   │   ├── decode.ts      # Octal escape decoder (\xxx → bytes)
│   │   └── index.ts       # Re-exports
│   │
│   ├── transport/         # Node.js transport layer
│   │   ├── spawn.ts       # child_process.spawn("tmux", ["-C", ...])
│   │   ├── types.ts       # Transport interface
│   │   └── index.ts       # Re-exports
│   │
│   ├── pane-session.ts    # Headless seed→live state machine + TerminalSink interface
│   ├── client.ts          # High-level TmuxClient combining both layers
│   └── index.ts           # Package root
│
├── examples/
│   └── web-multiplexer/   # Reference React/MobX + xterm.js demo (web + Electron entry paths) — see Section 10
│
├── tests/
│   ├── unit/              # Protocol parser, decoder, encoder
│   ├── integration/       # Real tmux process tests
│   └── e2e/               # Playwright + Electron tests
│
├── package.json           # Multiple entry points via "exports"
```

### Entry Points

```jsonc
{
  "exports": {
    ".": {
      // Full client — Node.js / Electron main process only
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./protocol": {
      // Pure protocol — works in browser, Deno, Bun, anywhere
      "types": "./dist/protocol/index.d.ts",
      "default": "./dist/protocol/index.js"
    }
  }
}
```

Consumers pick what they need:

```ts
// Node.js / Electron main — full client with spawn transport, plus
// PaneSession + TerminalSink for the headless seed→live state machine.
import {
  TmuxClient,
  spawnTmux,
  PaneSession,
  type TerminalSink,
} from "@promptctl/tmux-control-mode-js";

// Browser or anywhere — protocol only
import { TmuxParser, decode } from "@promptctl/tmux-control-mode-js/protocol";
```

### Why One Package, Not Two

Fewer packages to version, publish, and keep in sync. The protocol layer has
zero dependencies and tree-shakes cleanly — bundlers already eliminate the
transport code if you only import from `/protocol`. A monorepo split adds
coordination overhead for no real gain at this scale.

---

## 3. Protocol Layer (`protocol/`)

This layer has **zero Node.js dependencies**. It operates on strings and
`Uint8Array`s only. No `Buffer`, no `EventEmitter`, no `child_process`.

### 3.1 Message Types (`types.ts`)

A discriminated union covering every server-to-client message:

```ts
type TmuxMessage =
  | { type: "begin"; timestamp: number; commandNumber: number; flags: number }
  | { type: "end"; timestamp: number; commandNumber: number; flags: number }
  | { type: "error"; timestamp: number; commandNumber: number; flags: number }
  | { type: "output"; paneId: number; data: Uint8Array }
  | { type: "extended-output"; paneId: number; age: number; data: Uint8Array }
  | { type: "pause"; paneId: number }
  | { type: "continue"; paneId: number }
  | { type: "window-add"; windowId: number }
  | { type: "window-close"; windowId: number }
  | { type: "window-renamed"; windowId: number; name: string }
  // ... all 28 message types
  ;
```

### 3.2 Parser (`parser.ts`)

A **streaming, line-oriented parser** that accepts chunks of text (as they
arrive from the transport) and emits parsed `TmuxMessage` objects.

Design:

- **Push-based.** Caller feeds chunks via `parser.feed(chunk)`. Parser calls a
  callback for each complete message. This avoids coupling to any specific
  async primitive (Node streams, Web streams, async iterators).

- **Handles partial lines.** Maintains an internal buffer for incomplete lines
  split across chunks.

- **Response block tracking.** Tracks `%begin`/`%end`/`%error` state to
  aggregate command output lines into a single response object. Notifications
  outside response blocks are emitted immediately.

- **No async.** Parsing is synchronous and CPU-bound (just string splitting).
  Async belongs in the transport layer.

```ts
class TmuxParser {
  constructor(onMessage: (msg: TmuxMessage) => void);
  feed(chunk: string): void;
  reset(): void;
}
```

### 3.3 Octal Decoder (`decode.ts`)

Decodes the `\xxx` octal escaping used in `%output` and `%extended-output`
value fields.

```ts
function decodeOctalEscapes(encoded: string): Uint8Array;
```

Returns `Uint8Array` (not string) because pane output is arbitrary bytes — it
may contain incomplete UTF-8 sequences, binary data, or raw terminal escape
sequences. The consumer decides how to interpret the bytes.

### 3.4 Command Encoder (`encoder.ts`)

Builds properly formatted command strings. Primarily a convenience layer —
commands are just newline-terminated strings, but this handles escaping and
provides type-safe helpers for `refresh-client` subcommands.

```ts
function buildCommand(cmd: string): string;

// Typed helpers for control-mode-specific commands
function refreshClientSize(width: number, height: number): string;
function refreshClientPaneAction(paneId: number, action: PaneAction): string;
function refreshClientSubscribe(name: string, what: string, format: string): string;
function refreshClientUnsubscribe(name: string): string;
```

---

## 4. Transport Layer (`transport/`)

### 4.1 Transport Interface

A minimal interface that any transport must implement:

```ts
interface TmuxTransport {
  /** Send a command string to tmux */
  send(command: string): void;

  /** Register callback for incoming data chunks */
  onData(callback: (chunk: string) => void): void;

  /** Register callback for transport close/error */
  onClose(callback: (reason?: string) => void): void;

  /** Disconnect from tmux */
  close(): void;
}
```

This interface is intentionally minimal. It does not extend `EventEmitter` or
use Node streams — it's a plain object contract that any environment can
implement.

### 4.2 Spawn Transport (`spawn.ts`)

The default transport for Node.js / Electron. Spawns `tmux -C` as a child
process:

```ts
function spawnTmux(args: string[], options?: SpawnOptions): TmuxTransport;

// Example usage:
const transport = spawnTmux(["new-session", "-s", "main"]);
const transport = spawnTmux(["attach-session", "-t", "existing"]);
```

Options should include:

- `tmuxPath`: path to tmux binary (default: `"tmux"`)
- `socketPath`: `-L` / `-S` socket options
- `env`: environment variables for the child process
- `controlControl`: whether to use `-CC` mode (default: `false`)

---

## 5. High-Level Client (`client.ts`)

Combines protocol + transport into a convenient API:

```ts
class TmuxClient {
  constructor(transport: TmuxTransport);

  // Typed event emitter
  on<K extends keyof TmuxEventMap>(event: K, handler: (ev: TmuxEventMap[K]) => void): void;
  off<K extends keyof TmuxEventMap>(event: K, handler: (ev: TmuxEventMap[K]) => void): void;

  // Command execution with response tracking
  execute(command: string): Promise<CommandResponse>;

  // Convenience methods
  listWindows(): Promise<CommandResponse>;
  listPanes(): Promise<CommandResponse>;
  sendKeys(target: string, keys: string): Promise<CommandResponse>;
  splitWindow(options?: SplitOptions): Promise<CommandResponse>;

  // Control-mode-specific
  setSize(width: number, height: number): Promise<CommandResponse>;
  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse>;

  // Format subscriptions — see §5.1.
  subscribeSessions<F extends string>(fields: readonly F[], handler: (rows: Record<F, string>[]) => void): Promise<SubscriptionHandle>;
  subscribeWindows<F extends string>(fields: readonly F[], handler: (rows: Record<F, string>[]) => void): Promise<SubscriptionHandle>;
  subscribePanes<F extends string>(fields: readonly F[], handler: (rows: Record<F, string>[]) => void): Promise<SubscriptionHandle>;
  subscribe(opts: { what: string; format: string }, handler: (value: string) => void): Promise<SubscriptionHandle>;

  // Lifecycle
  close(): void;
}
```

### 5.1 Format subscriptions

The typed helpers (`subscribeSessions` / `subscribeWindows` / `subscribePanes`)
take a list of tmux format fields (e.g. `["pane_id", "pane_index"]`) and a
handler that receives `Record<F, string>[]` — a typed row per session, window,
or pane. The library:

- **Builds the format string** from the field list. Each field becomes
  `#{field}`; the row is delimited by US (`\x1f`) and terminated by RS
  (`\x1e`), then wrapped in the appropriate `#{S:...}` / `#{S:#{W:...}}` /
  `#{S:#{W:#{P:...}}}` iteration scope. **RS/US are C0 control bytes that
  cannot appear in any tmux name** — so a session named `weird|name` or
  containing literal newlines parses correctly, where the demo's previous
  `\n`-terminated `|`-delimited shape would have collided.
- **Auto-allocates the subscription name** as `tmux-cm-sub-<n>` per
  TmuxClient instance. Consumers never see the name; they get a
  `SubscriptionHandle` whose `dispose()` removes the route synchronously and
  fire-and-forget unsubscribes from tmux.
- **Routes `%subscription-changed` events** through one internal listener
  per client (installed lazily on first `subscribe*` call) and a
  `Map<name, handler>`. Calls to `subscribe(opts, handler)` use the same
  routing for non-S/W/P scopes — caller chooses the format string and is
  responsible for separator safety.

`buildScopedFormat` and `parseRows` are exported so consumers running over
a transport that can't carry a handler closure (e.g. cross-process bridges)
can still build the same wire shape and parse the value through library
functions rather than reinventing the format.

The legacy `subscribeRaw(name, what, format)` / `unsubscribeRaw(name)`
methods exist for connector layers (Electron main, RPC dispatch) that
multiplex a caller-supplied subscription name across IPC. These are marked
`@internal`; end-users should prefer the typed helpers.

### 5.2 TmuxModel — reactive topology projection (`model/`)

`TmuxModel` is the layer above `TmuxClient`. The wire client ends at "what
did tmux send"; `TmuxModel` answers "what does the topology look like, and
what just changed." Every consumer that wanted a session/window/pane tree
was reinventing the same projection above the wire — the library now owns
it.

```ts
class TmuxModel {
  constructor(client: TmuxClient, opts?: { signal?: AbortSignal });

  snapshot(): TmuxSnapshot;
  refreshSession(sessionId: number): Promise<void>;  // exposed fast-path
  dispose(): void;

  on('ready',    () => void): Disposable;
  on('snapshot', (s: TmuxSnapshot) => void): Disposable;
  on('change',   (d: TmuxDiff) => void): Disposable;
  on('error',    (e: TmuxModelError) => void): Disposable;

  // Convenience selector delegates — same impl as the pure functions below.
  activeSessionId(): number | null;
  activeWindowId(): number | null;
  activePaneId(): number | null;
  currentSession(): SessionSnapshot | null;
  currentWindow(): WindowSnapshot | null;
  paneLabels(): Map<number, string>;
}

// Pure selectors — composable, framework-agnostic, work on any snapshot
// (replayed, frozen, mocked).
function activeSessionId(s: TmuxSnapshot): number | null;
function activeWindowId(s: TmuxSnapshot): number | null;
function activePaneId(s: TmuxSnapshot): number | null;
function currentSession(s: TmuxSnapshot): SessionSnapshot | null;
function currentWindow(s: TmuxSnapshot): WindowSnapshot | null;
function paneLabels(s: TmuxSnapshot): Map<number, string>;
function findPane(s: TmuxSnapshot, paneId: number): PaneSnapshot | null;

// Pure diff — useful for consumers that need just the delta, not the tree.
function computeDiff(prev: TmuxSnapshot | null, next: TmuxSnapshot): TmuxDiff;
```

Architecture (the demo's intent, the demo's bugs fixed):

- **Three nested format subscriptions**, one per tier (`#{S:...}` /
  `#{S:#{W:...}}` / `#{S:#{W:#{P:...}}}`). Field lists live in
  `src/model/format.ts` and nowhere else — the demo's per-file `*_FORMAT`
  constants are gone.
- **Auto-allocated subscription names** via `subscribeSessions/Windows/Panes`
  on `TmuxClient`. Two `TmuxModel` instances on one client never collide.
- **One record store per tier** — `Map<id, ParsedRecord>`. Subscription
  delivery, `list-*` bootstrap, and the two fast-paths all write through
  the same maps; `rebuild()` is a pure function over them. The demo's
  `mergeSessionRows` / `mergePaneRowsByWindow` string-splice machinery
  collapses to "delete keys with this prefix, set fresh keys."
  [LAW:single-enforcer]
- **Two fast-paths for sub-1s feedback** (subscriptions are throttled to
  ~1Hz):
  - `refreshSession(sessionId)` — re-runs `list-windows -t`/`list-panes -s -t`
    for one session and merges into the maps. Triggered automatically off
    `%session-window-changed`, `%window-pane-changed`, and
    `%client-session-changed`; also exposed publicly.
  - `refreshWindowDimensions(windowId)` — re-runs `list-panes -t @id` for
    one window. Triggered off `%layout-change`. Same canonical pane format
    string as the steady-state subscription, so there is one parser, one
    record shape, and one write path.
- **`ready` fires once** when all three tiers AND `clientSessionId` are
  populated. After ready, `model.activeSessionId()` returns a real id, not
  `null` — consumers don't have to handle a half-populated transition.
- **`change` carries a structural diff** with per-tier
  `{ added, removed, renamed, dimChanged, titleChanged, attachChanged,
    activeChanged, zoomedChanged }` plus `clientSessionChanged`. Computed
  from id-set comparisons on each rebuild (cheap for the snapshot sizes
  tmux produces). Consumers wanting "react to *this* pane's title
  changing" don't diff snapshots themselves — they read the field they
  care about off the diff. [LAW:single-enforcer]
- **`width` and `height` are `number | null`**, not `number`-with-magic-
  fallback. The demo's `width || 80` encoded "unknown" as control flow;
  the library encodes it in the type so consumers handle the unknown
  case explicitly.
- **Active state is derived, never stored.** `session.attached`,
  `window.active`, `pane.active` ARE the truth in the snapshot tree;
  selectors recompute the active id on every call. Stale-cache class of
  bug is impossible. [LAW:dataflow-not-control-flow]
- **`clientSessionId` captured from `%client-session-changed` only** — the
  one piece of per-client state subscriptions cannot deliver. Bootstrapped
  via `display-message -p '#{session_id}'` in case the event fired before
  the model attached its listener.
- **Events `session-window-changed` / `window-pane-changed` aren't patched
  into local state** — they only kick the fast-path. Patching those events
  would create parallel state. Subscriptions cover the steady-state truth.
- **`dispose()` is full-shutdown.** `SubscriptionHandle.dispose()` for each
  installed subscription removes the route in `TmuxClient` synchronously
  and fire-and-forget unsubscribes from tmux. Direct event listeners are
  detached. Records are cleared. Subsequent `%subscription-changed` events
  are dropped silently. Idempotent.

#### Framework adapters

`TmuxModel` is event-driven, not framework-specific. Wrap `model.snapshot()`
once at the application boundary and let your framework take over.

**MobX** (the web-multiplexer demo's flavour):

```ts
import { observable, action, runInAction } from "mobx";

class MobxTopology {
  snapshot = observable.box(model.snapshot(), { deep: false });
  constructor(model: TmuxModel) {
    model.on("snapshot", (s) =>
      runInAction(() => this.snapshot.set(s)),
    );
  }
}
// Components observe `topology.snapshot.get()` — every TmuxModel rebuild
// triggers a re-render with the new snapshot.
```

**Zustand**:

```ts
import { create } from "zustand";

const useTopology = create<{ snapshot: TmuxSnapshot }>((set) => ({
  snapshot: model.snapshot(),
}));
model.on("snapshot", (s) => useTopology.setState({ snapshot: s }));
// const sessions = useTopology(s => s.snapshot.sessions);
```

**Signals** (Preact / Solid / Vue):

```ts
const snapshot = signal(model.snapshot());
model.on("snapshot", (s) => (snapshot.value = s));
```

The shape doesn't change across frameworks — only the wrapping. If your
framework needs immutable inputs, the snapshot already is one (the diff
is computed by id, not by reference equality).

### Response Correlation

The client tracks in-flight commands by `command-number` from `%begin` lines.
`execute()` returns a `Promise<CommandResponse>` that resolves when the
matching `%end` arrives or rejects with a `TmuxCommandError` on `%error`.
This is the primary mechanism for correlating requests with responses.

```ts
interface CommandResponse {
  commandNumber: number;
  timestamp: number;
  output: string[];   // Lines between %begin and %end
  success: boolean;   // true for %end, false (only on TmuxCommandError.response) for %error
}

class TmuxCommandError extends Error {
  readonly response: CommandResponse; // success: false, plus output lines
}
```

**Rejection contract:** all command-shaped methods (`execute`, `sendKeys`,
`splitWindow`, `setSize`, `setPaneAction`, `subscribe`, `unsubscribe`,
`setFlags`, `clearFlags`, `requestReport`, `queryClipboard`) reject with a
`TmuxCommandError` instance carrying the original `CommandResponse` on
`.response`. Callers should `instanceof TmuxCommandError` rather than
duck-typing on `success: false`.

> Pre-0.2 versions rejected with the raw `CommandResponse` object. That is a
> breaking change. Migrate `catch (r: CommandResponse) => r.success` →
> `catch (e) => e instanceof TmuxCommandError ? e.response : (throw e)`.

---

## 6. Browser / WebSocket Usage

The protocol layer works in the browser as-is. For browser-based tmux
management UIs, a WebSocket relay bridges the gap:

```
┌──────────┐  WebSocket  ┌──────────────┐  stdin/stdout  ┌──────┐
│  Browser  │ ──────────→ │  Relay Server │ ─────────────→ │ tmux │
│  (parser) │ ←────────── │  (Node.js)   │ ←───────────── │      │
└──────────┘              └──────────────┘                └──────┘
```

### WebSocket Transport Adapter

A thin adapter that implements `TmuxTransport` over a WebSocket:

```ts
// Ships with the package as an optional connector
function websocketTransport(ws: WebSocket): TmuxTransport;
```

This adapter is platform-agnostic — it works with the browser `WebSocket` API,
`ws` in Node.js, or any compatible implementation.

### Relay Server

The relay server is intentionally **not** part of this package. It's a simple
bridge (spawn tmux, pipe stdin/stdout to WebSocket) that is
deployment-specific. A reference implementation or example could live in an
`examples/` directory. The relay is ~30 lines of code with `ws` +
`child_process`.

---

## 7. Connectors and Shims

### 7.0 Shared RPC Layer (`connectors/rpc.ts`, `connectors/rpc-dispatch.ts`)

Every bridge connector exposes the same fundamental shape: parse an untrusted
`{ method, args }` payload from a peer/renderer, dispatch it to the matching
`TmuxClient` method, and reply with a `CommandResponse`. Two files own that
shape for **all** connectors:

- `src/connectors/rpc.ts` — renderer-safe (zero Node imports). Defines the
  `RpcRequest` discriminated union (one variant per bridged TmuxClient
  method), `RpcMethod`, `RpcError`, and `parseRpcRequest(unknown)`. The
  electron renderer can transitively reach this without dragging Node code
  into its bundle.
- `src/connectors/rpc-dispatch.ts` — Node-side. Imports `TmuxClient` (for the
  Dispatcher type) and exports `dispatchRpcRequest(client, req)`, which is
  exhaustively typed against `RpcRequest` and returns the appropriate
  `CommandResponse` for each bridged method without requiring transport
  layers to special-case individual RPC variants.

**Adding a TmuxClient method to the bridges:**

1. Add the variant to `RpcRequest` in `rpc.ts`.
2. Add the validator arm to `VALIDATORS` in `rpc.ts`.
3. Add the dispatcher arm to `DISPATCH` in `rpc-dispatch.ts`.

Both connectors pick the change up automatically. Missing entries fail at
compile time via the mapped-type exhaustiveness in `Validators` and
`Dispatcher`.

The connector source files stay focused on transport-specific concerns:

- `connectors/electron/main.ts` owns single-instance enforcement, the
  per-renderer subscriber set, and the credit-based backpressure loop.
  Its invoke handler is a 5-line straight pipe through `parseRpcRequest`
  + `dispatchRpcRequest`.
- `connectors/websocket/server.ts` owns the WebSocket frame protocol,
  authentication/authorization hooks, rate limits, heartbeats, and drain
  semantics. Its `onCall` straight-pipes through the same RPC functions —
  no per-method dispatch table, no `isFireMethod` branch, no
  `isTmuxError` duck-check (it catches `instanceof TmuxCommandError`
  directly).

`Connection` in `server.ts` models its lifecycle as a discriminated
`ConnectionState` union (`pending-hello | running | draining | closed`)
where the `running` and `draining` variants carry the live `TmuxClient` and
`ConnectionContext`. `onCall` takes the narrowed `running` state as a
parameter, so `client === null` is structurally unrepresentable inside it
— no defensive guard needed.

### 7.1 Electron IPC Bridge

In Electron, tmux must run in the main process (it needs `child_process`). An
IPC bridge sends parsed events to the renderer:

```ts
// Main process
import { TmuxClient, spawnTmux } from "@promptctl/tmux-control-mode-js";
import { ipcMain } from "electron";

const client = new TmuxClient(spawnTmux(["new-session"]));
client.on("*", (event) => mainWindow.webContents.send("tmux-event", event));
ipcMain.handle("tmux-command", (_, cmd) => client.execute(cmd));

// Renderer process (preload-safe)
import { TmuxParser } from "@promptctl/tmux-control-mode-js/protocol";
const { ipcRenderer } = require("electron");

ipcRenderer.on("tmux-event", (_, event) => { /* handle parsed event */ });
ipcRenderer.invoke("tmux-command", "list-windows");
```

We should ship a helper for this pattern:

```ts
// electron-bridge.ts (ships with package, optional import)
function createMainBridge(client: TmuxClient, ipcMain: IpcMain): void;
function createRendererBridge(ipcRenderer: IpcRenderer): TmuxClientProxy;
```

`TmuxClientProxy` has the same API shape as `TmuxClient` but proxies over IPC.
The renderer never imports Node.js modules directly.

### 7.2 Readable Stream Adapter

For consumers that prefer Node.js `Readable` streams or Web `ReadableStream`:

```ts
// Wraps TmuxClient events as a ReadableStream of TmuxMessage
function toReadableStream(client: TmuxClient): ReadableStream<TmuxMessage>;

// Wraps TmuxClient events as a Node.js Readable (objectMode)
function toNodeStream(client: TmuxClient): import("stream").Readable;
```

### 7.3 Event Emitter Compatibility

The client's event system should be a minimal custom implementation (not
Node.js `EventEmitter`) so the type signatures stay clean and it works in
non-Node environments. If consumers need Node.js `EventEmitter` compatibility:

```ts
function toEventEmitter(client: TmuxClient): import("events").EventEmitter;
```

---

## 8. Security Considerations

### 8.1 Command Injection

**Risk:** If user-provided strings are interpolated into tmux commands without
escaping, an attacker can inject arbitrary tmux commands (and via `run-shell`,
arbitrary shell commands).

**Mitigation:**

- The `encoder` module must properly escape all user-provided arguments.
  tmux uses single-quote escaping: wrap arguments in `'...'` and escape
  embedded single quotes as `'\''`.
- `execute()` should accept structured arguments, not raw command strings,
  for the convenience methods. The raw `execute(string)` method is an escape
  hatch — document that the caller is responsible for escaping.
- Never interpolate pane output or notification data back into commands.

### 8.2 Pane Output as Untrusted Data

**Risk:** Pane output (`%output` / `%extended-output`) contains arbitrary
bytes from whatever program is running in the pane. This data must never be:

- Inserted into HTML without sanitization (XSS in Electron renderer)
- Used to construct file paths, commands, or database queries
- Assumed to be valid UTF-8

**Mitigation:**

- The decoder returns `Uint8Array`, not `string`. The consumer explicitly
  chooses when and how to decode to text.
- Document that pane output is **untrusted external data** in the same
  category as network input.
- In Electron, the renderer process should sanitize before DOM insertion.
  The protocol layer does not sanitize — that is the renderer's job.

### 8.3 Notification Data Injection

**Risk:** Notification fields like window names and session names come from
tmux, which gets them from user input or programs. A window named
`<script>alert(1)</script>` would be an XSS vector if rendered unsanitized.

**Mitigation:**

- Treat all string fields in parsed messages as untrusted.
- Document this clearly in the type definitions (JSDoc on each field).
- The parser does not sanitize — it faithfully represents what tmux sent.
  Sanitization is the renderer's responsibility.

### 8.4 Transport Security

**Risk:** The tmux socket and child process stdin/stdout carry full control
over tmux sessions. Anyone who can write to the transport can execute arbitrary
commands in any pane.

**Mitigation:**

- The spawn transport should not expose the child process object directly.
  Consumers interact through the `TmuxTransport` interface only.
- For WebSocket relays: use authentication (tokens, session cookies) and
  TLS. The relay server example should demonstrate this. Never expose a
  tmux relay on a network without authentication.
- Document that the tmux socket path permissions matter — tmux already
  restricts socket access to the owning user, but a misconfigured relay
  can bypass this.

### 8.5 Electron-Specific

**Risk:** Electron's renderer process should not have direct access to
`child_process`. If the renderer is compromised (XSS), access to the tmux
transport means full shell access.

**Mitigation:**

- The IPC bridge pattern (Section 7.1) keeps `child_process` in the main
  process. The renderer only sees parsed events and can only send commands
  through a controlled IPC channel.
- The main process IPC handler should validate commands before forwarding
  to tmux — at minimum, reject commands containing `run-shell` unless
  explicitly allowed.
- Enable `contextIsolation` and `sandbox` in Electron's
  `BrowserWindow` options. Use a preload script to expose only the
  IPC bridge, not the full `TmuxClient`.

### 8.6 Denial of Service

**Risk:** A runaway program in a pane can produce output faster than the
client can consume it, leading to unbounded memory growth in the parser's
output buffer.

**Mitigation:**

- Use `pause-after` flag (recommended: `pause-after=1`) so tmux
  automatically pauses panes that fall behind. This is the protocol's
  built-in backpressure mechanism.
- The parser should have a configurable maximum line length and maximum
  buffer size. Lines exceeding the limit should be truncated or cause a
  parse error, not an OOM.
- Monitor the `%pause` notification and surface it to the UI so users
  know output is being throttled.

---

## 9. Terminal Rendering with xterm.js

### 9.1 Why xterm.js

xterm.js is the standard embeddable terminal for Electron and browser
environments. VS Code, Hyper, Theia, and dozens of production apps use it. It
handles the hard parts we don't want to reimplement: VT escape sequence
interpretation, grid state, cursor tracking, selection, scrollback, GPU
rendering, ligatures, and accessibility.

Alternatives considered:

- **Hyper** — built *on* xterm.js. Forking it adds an application shell we
  don't need.
- **Warp** — closed source, not embeddable.
- **Custom terminal** — unjustifiable effort. The terminal emulator problem is
  solved; our value is in the tmux integration.

### 9.2 Integration Architecture

Each tmux pane maps to one `PaneSession` (library) bound to one `TerminalSink`
(consumer-supplied — typically wrapping an xterm.js `Terminal`). PaneSession
owns the seed→live state machine; the sink is just the renderer adapter.

```
tmux server
  │
  │  %output %5 \033[1;32mhello\033[0m\012
  ▼
TmuxClient (main process)
  │  parses → { type: "output", paneId: 5, data: Uint8Array }
  │
  │  IPC (Electron) or direct call
  ▼
PaneSession (filters by paneId, dispatches via current bytePath)
  │
  │  bytePath(data)
  ▼
TerminalSink.write(bytes)
  │
  ▼
xterm.js Terminal — interprets escape sequences, updates grid
```

User input flows in reverse:

```
xterm.js Terminal
  │  terminal.onData(data)   // user typed "ls\r"
  ▼
TerminalSink.onData handler
  ▼
PaneSession (encodes to UTF-8, calls client.sendKeys("%5", text))
  ▼
TmuxClient
  │  sends `send-keys -t '%5' -l '...'` over transport
  ▼
tmux server
```

### 9.3 TerminalSink Interface

PaneSession drives the renderer through a small structural interface, so the
library never imports xterm.js. xterm.js's `Terminal` is wrapped by a tiny
adapter (`createXtermSink`); other backends (headless captures, alternate
emulators) wrap themselves.

```ts
interface TerminalSink {
  /** Write decoded pane output bytes. */
  write(bytes: Uint8Array): void;
  /** Set the sink's logical dimensions (cols × rows). */
  resize(cols: number, rows: number): void;
  /** Subscribe to user keystrokes; PaneSession forwards them to send-keys. */
  onData(handler: (bytes: Uint8Array) => void): { dispose(): void };
  /** Move keyboard focus to the sink. */
  focus(): void;
}
```

[LAW:locality-or-seam] The sink is the seam between PaneSession and any
renderer. Adding a sink-specific quirk (e.g. xterm's first-resize crash
workaround) belongs in the adapter, not in PaneSession.

### 9.4 PaneSession

`PaneSession` is the per-pane state machine: `idle → seeding → live →
disposed`. One instance per pane the consumer is rendering.

```ts
class PaneSession {
  constructor(opts: {
    client: PaneSessionClient;        // TmuxClient or a bridge adapter
    paneId: number;
    sink: TerminalSink;
    bufferLimitBytes?: number;        // default 4 MiB
  });

  attach(): Promise<void>;             // begin seeding; resolves at flip time
  resize(cols: number, rows: number): void;  // mirrors to sink only — NOT to tmux
  focus(): void;
  dispose(): void;                     // idempotent; AbortController-driven teardown

  on("state-change", h);               // 'idle'|'seeding'|'live'|'disposed'
  on("seed-error", h);                 // capture/cursor query failed
  on("seed-overflow", h);              // bounded buffer dropped oldest tail
  // off() symmetrical
}
```

Responsibilities:

- **Output routing.** Subscribes once to `output` + `extended-output` on the
  client, filters by `paneId`, dispatches every byte through `bytePath`.
  [LAW:dataflow-not-control-flow] During seed, `bytePath` appends to a
  bounded buffer; at flip time it is atomically swapped to write straight
  to the sink. The same line of code runs every event.
- **Input routing.** Hooks `sink.onData`, encodes to UTF-8, calls
  `client.sendKeys('%<id>', text)`. Fire-and-forget — the FIFO queue inside
  `TmuxClient` preserves ordering relative to other commands.
- **Seed/live state machine.** See §9.5.
- **Lifecycle.** A single `AbortController` owns teardown. `dispose()` aborts;
  output listeners detach; the input disposable runs; the byte path flips to
  a no-op so any in-flight emit racing the abort lands on the floor with no
  per-callback `if (state === "disposed") return` guards. [LAW:single-enforcer]

What PaneSession deliberately does NOT do:

- **No `resize-pane` to tmux.** `resize(cols, rows)` mirrors to the sink only.
  The consumer's topology source is the canonical width/height; PaneSession
  is a passive mirror so the sink and tmux never disagree.
- **No pause/continue backpressure** (yet). xterm.js exposes a write-callback
  signal for buffered chunks; threading it back to `refresh-client -A
  %<id>:pause`/`:continue` is a follow-up ticket. The seed-phase buffer caps
  growth, but a slow live sink still drops bytes silently into xterm's queue.
- **No multi-pane management.** One `PaneSession` per pane; the consumer
  owns the collection (whether that's a `DemoStore`-style hand-rolled tree
  or the planned `TmuxModel`).

### 9.5 Seed/Live State Machine

When a control-mode client attaches to an existing session the panes already
have content; tmux does NOT replay historical output. PaneSession bridges the
gap:

1. `attach()` registers the pane-output listener BEFORE issuing any commands,
   so bytes arriving in the seed window are captured, not dropped.
2. In parallel:
   - `capture-pane -e -p -S - -t %<id>` — full scrollback through visible
     screen, including escape sequences.
   - `display-message -p -t %<id> '#{cursor_x};#{cursor_y}'` — tmux's
     authoritative cursor position (0-indexed within the visible screen).
3. When both commands complete, synchronously (no await between the steps so
   no event can interleave):
   a. Write the captured snapshot to the sink.
   b. Write an ANSI CUP escape (`\x1b[<row>;<col>H`, 1-indexed) so the
      cursor lands at tmux's reported position rather than at the bottom of
      the captured buffer.
   c. Drain the seed-phase buffer in arrival order — live events that
      landed during the seed window appear on top of the snapshot at the
      snapshot's cursor.
   d. Atomically swap `bytePath` to write straight to the sink. State =
      `live`.

If `capture-pane` or `display-message` fails (pane went away, transport
hiccup), PaneSession transitions to `live` anyway — the seed buffer is
dropped (rootless without a snapshot) and a typed `seed-error` event fires.
[LAW:errors:no-silent-fallbacks] The library does not `console.error` and
continue; the consumer decides whether to surface a "snapshot unavailable"
affordance or trigger a reattach.

If the seed buffer hits `bufferLimitBytes` (default 4 MiB), the oldest
queued events are dropped to bring usage back under the cap and a
`seed-overflow` event fires with the dropped count. Most likely cause: the
seed is genuinely stuck and a reattach is the right move.

### 9.6 Recommended xterm.js Addons

| Addon | Purpose |
|-------|---------|
| `@xterm/addon-fit` | Auto-resize terminal to fill container; triggers `onResize` |
| `@xterm/addon-webgl` | GPU-accelerated rendering; significant performance improvement |
| `@xterm/addon-web-links` | Clickable URLs in terminal output |
| `@xterm/addon-search` | Find-in-terminal (complements tmux's own copy-mode search) |
| `@xterm/addon-unicode11` | Proper width calculation for CJK and emoji characters |
| `@xterm/addon-clipboard` | System clipboard integration |

### 9.7 Key Considerations

**Encoding:** xterm.js `write()` accepts both `string` and `Uint8Array`. Our
octal decoder returns `Uint8Array`. Pass it directly — xterm.js handles UTF-8
decoding internally, including incomplete multi-byte sequences across chunks.

**Flow control:** Use `pause-after=1` so tmux pauses panes that the client
can't keep up with. xterm.js `write()` returns a Promise when buffering is
full — we can use this as a signal to defer processing more `%output` events.
xterm.js also exposes a `write()` callback overload that fires when the chunk
has been processed, which can be used for backpressure signaling.

**`send-keys` escaping:** User keystrokes from `terminal.onData()` are UTF-8
strings or control sequences. Use `send-keys -l` (literal mode) for most input
to avoid tmux interpreting key names. For special keys (arrow keys, function
keys), map the xterm.js escape sequences back to tmux key names.

**Resize coordination:** When xterm.js resizes (via `addon-fit` or manual
resize), send `refresh-client -C <cols>x<rows>` for the overall client size,
or per-window sizes if panes in different windows have different dimensions.
Debounce resize events — rapid resizing during window drag generates many
events.

---

## 10. Reference Example (`examples/web-multiplexer/`)

A single React/MobX + xterm.js demo with two entry paths off a shared
`TmuxBridge` interface: a web target (renderer ↔ Node bridge over WebSocket)
and a desktop target (renderer ↔ main over Electron IPC). One renderer, one
store, one set of components — the bridge is the seam.

This is not a toy. It's a working tmux client that exercises every layer of
the library, and the e2e suite runs against it.

### 10.1 Structure

```
examples/web-multiplexer/
├── package.json            # React, MobX, xterm.js, Mantine, ws, electron
├── server/
│   └── bridge.ts           # WebSocket relay → spawnTmux + TmuxClient
├── electron/
│   ├── main.ts             # Electron main: spawnTmux + createMainBridge
│   ├── preload.ts          # contextBridge → window.tmuxIpc
│   └── build.mjs           # esbuild orchestration for main + preload
├── web/
│   ├── main.tsx            # Web entry — instantiates WebSocketBridge
│   ├── main-electron.tsx   # Electron entry — instantiates ElectronBridge
│   ├── App.tsx             # Layout, tab bar, pane grid
│   ├── store.ts            # MobX store: sessions, windows, panes, layout
│   ├── pane-terminal.ts    # Per-pane xterm.js Terminal + lifecycle
│   ├── ws-client.ts        # WebSocketBridge — TmuxBridge over WebSocket
│   ├── electron-bridge.ts  # ElectronBridge — TmuxBridge over Electron IPC
│   └── components/         # Tab bar, status, inspector, heatmap, etc.
├── shared/                 # Types crossing the bridge boundary
└── index.html              # Vite shell
```

### 10.2 What It Demonstrates

- Spawning `tmux -C new-session` and `tmux -C attach-session`
- Rendering pane output in xterm.js terminals
- Sending user keystrokes back to panes
- Tab bar updated from `%window-add`, `%window-close`, `%window-renamed`
- Active pane switching from `%window-pane-changed`
- Layout updates from `%layout-change` (split pane resizing)
- Session switching from `%session-changed`
- Client resize via `refresh-client -C` when the window resizes
- Initial pane sync with `capture-pane`
- Backpressure via `pause-after` flag
- The same renderer running over both transport shapes — proving the
  `TmuxBridge` interface is the right seam.

### 10.3 Intentional Limitations

The demo is a reference, not a product. No preferences UI, no tmux command
palette, no settings persistence. Just enough surface to prove every
protocol path and both bridge shapes work end-to-end.

---

## 11. Testing Strategy

### 11.1 Protocol Layer (Unit Tests — `vitest`)

- **Fixture replay:** Captured tmux control mode sessions replayed through the
  parser. Compare parsed output against expected `TmuxMessage` objects.
- **Fuzz the parser** with malformed input: partial lines, binary garbage,
  extremely long lines, embedded `%begin` inside output blocks.
- **Octal decoder** edge cases: `\000`, `\134` (backslash), `\377` (0xFF),
  sequences at chunk boundaries, incomplete `\xx` at end of chunk.
- **Command encoder:** Verify escaping of special characters, single quotes,
  backslashes, newlines.

These are fast, pure, no-IO tests. They run on every commit.

### 11.2 Transport Layer (Integration Tests — `vitest`)

- **Live tmux tests** that spawn a real `tmux -C` process, send commands, and
  verify responses. Gated behind an environment check (`TMUX_INTEGRATION=1`)
  so they only run when tmux is available.
- **Mock transport** for testing the client's command correlation (request →
  response matching by command number) without a real tmux.
- **Backpressure test:** Verify that `pause-after` works — run a program
  that floods output, confirm `%pause` is received, send `continue`, confirm
  `%continue` arrives and output resumes.

### 11.3 xterm.js Integration Tests (Playwright)

These are the integration tests that run against the reference example
(`examples/web-multiplexer/`, Electron entry path). They exercise the full
stack: spawn tmux → parse protocol → render in xterm.js → capture terminal
state → verify.

**Test runner:** Playwright with Electron support (`electron.launch()`).
Playwright can drive the Electron app, interact with the xterm.js terminals,
and assert on rendered content.

**Test categories:**

```
tests/integration/
├── connection.test.ts       # Attach/new-session, %exit on detach
├── output-rendering.test.ts # Run "echo hello", verify xterm.js shows it
├── input.test.ts            # Type in xterm.js, verify command executes
├── pane-lifecycle.test.ts   # Split pane, close pane, verify DOM updates
├── window-lifecycle.test.ts # New window, rename, close, verify tab bar
├── resize.test.ts           # Resize Electron window, verify refresh-client -C
├── layout.test.ts           # Split panes, verify %layout-change updates
├── session.test.ts          # Switch session, verify %session-changed
├── backpressure.test.ts     # Flood output, verify pause/continue cycle
├── initial-sync.test.ts     # Attach to existing session, verify capture-pane
└── escape-sequences.test.ts # Colors, cursor movement, verify xterm.js grid
```

**How the tests work:**

1. Playwright launches the Electron example app.
2. The app spawns `tmux -C new-session` (or attaches to a fixture session).
3. Tests send tmux commands via the app's IPC bridge (Playwright can call
   `electron.evaluate()` in the main process).
4. Tests read xterm.js terminal state by querying the `Terminal.buffer` API
   from the renderer (Playwright can evaluate in the renderer context).
5. Assertions compare expected terminal content against actual grid state.

**Example test:**

```ts
test("echo renders in terminal", async ({ electronApp }) => {
  const page = await electronApp.firstWindow();

  // Send a command to the active pane via IPC
  await electronApp.evaluate(async ({ ipcMain }) => {
    // TmuxClient is in main process
    await globalThis.tmuxClient.execute("send-keys 'echo hello' Enter");
  });

  // Wait for xterm.js to render
  await page.waitForTimeout(500);

  // Read terminal buffer from renderer
  const content = await page.evaluate(() => {
    const terminal = globalThis.paneManager.getActiveTerminal();
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString().trimEnd());
    }
    return lines.filter(Boolean).join("\n");
  });

  expect(content).toContain("hello");
});
```

**CI setup:**

- Linux CI runners with `tmux` installed (standard in most CI images).
- `xvfb-run` for headless Electron (Playwright handles this automatically).
- macOS CI runners for Electron-on-Mac verification.
- Tests can run without a display server using Playwright's headless Electron
  mode.

### 11.4 Testing Pyramid

```
     ╱╲        Playwright + Electron + xterm.js
    ╱  ╲       (10-15 tests, slow, full stack)
   ╱────╲
  ╱      ╲     Integration with real tmux
 ╱        ╲    (20-30 tests, medium speed)
╱──────────╲
╱            ╲   Protocol unit tests
╱              ╲  (100+ tests, fast, pure)
╱────────────────╲
```

The protocol unit tests catch the vast majority of bugs. The integration
tests catch transport issues. The Playwright tests catch rendering and
wiring issues. Together, they de-risk the entire integration.

---

## 12. Build and Distribution

- **Target:** ESM only (`"type": "module"`). CJS consumers can use dynamic
  `import()`.
- **TypeScript:** Emit declarations (`.d.ts`) alongside JS.
- **Browser compatibility:** The `protocol/` entry point should be
  compatible with any bundler (Vite, webpack, esbuild). No conditional
  `require()` or Node.js globals.
- **Tree-shaking:** Use named exports, avoid side effects in module scope.
  Mark `"sideEffects": false` in package.json.
