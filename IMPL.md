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
│   ├── client.ts          # High-level TmuxClient combining both layers
│   └── index.ts           # Package root
│
│   (additional subtrees exist in the repo — see `src/` for the current
│    layout, and package.json `exports` for what ships.)
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
    },
    // ...plus ./keymap and explicit connector entry points under
    // ./websocket, ./electron, and ./streams (no pattern exports — each
    // subpath is named individually). See the `exports` map in
    // package.json for the canonical list.
  }
}
```

Consumers pick what they need:

```ts
// Electron main process — full client with spawn transport
import { TmuxClient, spawnTmux } from "@promptctl/tmux-control-mode-js";

// Browser or anywhere — protocol only
import { TmuxParser, decodeOctalEscapes } from "@promptctl/tmux-control-mode-js/protocol";
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
  // ... remaining variants in `src/protocol/types.ts` (the `TmuxMessage` union)
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
  subscribeRaw(name: string, what: string, format: string): Promise<CommandResponse>;
  unsubscribe(name: string): Promise<CommandResponse>;

  // Lifecycle
  close(): void;
}
```

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
`splitWindow`, `setSize`, `setPaneAction`, `subscribeRaw`, `unsubscribe`,
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

The relay server **does** ship with the package — `createWebSocketBridge` is
exported at the `./websocket/server` subpath (`src/connectors/websocket/server.ts`).
It accepts a `ServerWebSocketLike` connection, obtains a `TmuxClient` for
the connection via the caller-supplied `createClient(ctx)` hook (which may
spawn a fresh client per connection or return a shared one — the default
`disposeClient` is a no-op so shared clients work), and routes RPC through
the shared dispatcher in §7. Deployment shape (which `ws` server, auth,
draining, client-lifetime policy) is the caller's; the bridge itself is
the library's.

See `package.json#exports['./websocket/server']` for the consumer entry
point. The PR-#39 v0.1.0 publish smoke test exercises this path.

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
  per-renderer SenderState (WebContents handle, destroyed-listener wiring,
  in-flight invoke set), and ack-frame parsing. Its invoke handler is a
  short straight pipe through `parseRpcRequest` + `dispatchRpcRequest`,
  with subscribe/unsubscribe intercepted into the shared
  `BridgeConnection` helper for ownership tracking.
- `connectors/websocket/server.ts` owns the WebSocket frame protocol,
  authentication/authorization hooks, rate limits, heartbeats, and drain
  semantics. Its `onCall` straight-pipes through the same RPC functions —
  no per-method dispatch table, no `isFireMethod` branch, no
  `isTmuxError` duck-check (it catches `instanceof TmuxCommandError`
  directly). subscribe/unsubscribe are likewise intercepted into the
  shared `BridgeConnection` helper.
- `connectors/bridge-connection.ts` is the transport-agnostic per-peer
  bookkeeping shared by both bridges:
  - **Subscription ownership + refcount.** Every peer (one per renderer
    on Electron, one per WS connection) holds a Set of subscription names.
    A peer can only unsubscribe names it owns — cross-peer teardown
    attempts raise `BRIDGE_UNKNOWN_SUBSCRIPTION`. The first peer to claim
    a name writes the canonical `(what, format)` pair; subsequent peers
    claiming the same name with a divergent `(what, format)` are rejected
    with `BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT` (silently overwriting
    tmux's binding would change the wire format observed by prior
    subscribers — to update, unsubscribe first). Concurrent subscribers
    of the same name share fate via an `inflight` promise on the record:
    if tmux rejects the first call, every queued peer sees the same
    rejection — no peer is left holding a phantom subscription.
  - **Per-pane outstanding-byte accounting + watermark loop.** Every pane
    output forwarded to a peer adds to that peer's per-pane outstanding
    tally; when the per-pane sum (across all peers) crosses
    `outputHighWatermark`, the helper fires
    `client.setPaneAction(paneId, Pause)` exactly once. Acks decrement
    the sum; when it falls below `outputLowWatermark`, the helper
    resumes. On Electron the ack arrives via a `tmux:ack` IPC frame; on
    WebSocket the helper's `clearPeerOutstanding` is driven by
    `ws.bufferedAmount` reaching the low watermark (the only "in-flight
    bytes" signal the WS protocol exposes without a dedicated ack frame).

  **Scope: per-connection on WebSocket.** The Electron bridge installs ONE
  `BridgeConnection` and treats every renderer as a peer in it (sum-across-
  peers is the right semantics: pause is global at the tmux side). The WS
  bridge installs ONE `BridgeConnection` PER `Connection` because each
  connection's `createClient` hook may return a different `TmuxClient`. A
  consequence: when multiple WS connections share a TmuxClient and both
  subscribe the same name with divergent `(what, format)`, both
  `client.subscribeRaw` calls reach tmux and the second overwrites the
  first's binding — the cross-WS analog of the audit's C1 hazard. This is
  a known follow-up (lift the helper to factory scope keyed on TmuxClient
  with refcount); the qz5.5 ticket scoped C1 to Electron. Tracked as
  `tmux-connectors-qz5.5.1`.

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

The xterm.js integration ships as a separate workspace package,
`@promptctl/pane-terminal` (`packages/pane-terminal/`). Its subpath
exports — `./stream`, `./sink`, `./xterm-sink`, `./react`, `./vanilla` —
are the source of truth for the public surface; see
`packages/pane-terminal/package.json#exports`. The design rationale
(dimensions ownership, backpressure, scrollback restore, the
renderer/seam split) lives in `design-docs/pane-session-v2.md`.

Keeping the renderer in its own package preserves this library's
zero-runtime-dependency contract (xterm.js and React are pulled in only
by consumers that opt into `@promptctl/pane-terminal` — see its
`peerDependencies` for the authoritative list).

---

## 10. Reference Example (`examples/web-multiplexer/`)

A single React/MobX + xterm.js demo with two entry paths off a shared
`TmuxBridge` interface: a web target (renderer ↔ Node bridge over WebSocket)
and a desktop target (renderer ↔ main over Electron IPC). One renderer, one
store, one set of components — the bridge is the seam.

This is not a toy. It's a working tmux client that exercises every layer of
the library, and the e2e suite runs against it.

### 10.1 Structure

See `examples/web-multiplexer/` for the actual layout. The shape is a
top-level Vite project (`web/` renderer, `server/` Node bridge, `electron/`
desktop shell, `shared/` cross-boundary types, `tests/` e2e). Enumerating
the per-file tree in prose drifts on every demo edit; the directory itself
is the source of truth.

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

### 11.3 End-to-End Tests (Playwright + Electron)

End-to-end coverage drives the reference example (`examples/web-multiplexer/`)
through Playwright, including its Electron entry path. The full stack runs
unmodified: spawn tmux → parse protocol → bridge to the renderer → render in
xterm.js → assert on terminal state.

The on-disk inventory is the source of truth:

- `tests/e2e/` — Playwright specs (DOM and Electron entry points) plus their
  shared `global-setup.ts` / `socket-naming.ts` helpers and
  `playwright.config.ts`.
- `tests/integration/` — real-tmux integration suite, gated by
  `TMUX_INTEGRATION=1` (see §11.2). These are not Playwright tests; they
  exercise the library against a live `tmux -C` and never touch xterm.js.

**CI status:**

End-to-end tests are not currently part of CI — `.github/workflows/ci.yml`
runs unit and real-tmux integration only (Linux, `pnpm run test:integration`).
Run E2E locally with `pnpm run test:e2e` (Playwright drives `electron.launch()`;
on headless Linux you may need `xvfb-run`).

### 11.4 Testing Pyramid

```
     ╱╲        End-to-end (Playwright + Electron + xterm.js)
    ╱  ╲       Slow, full-stack
   ╱────╲
  ╱      ╲     Integration with real tmux
 ╱        ╲    Medium speed, gated by TMUX_INTEGRATION=1
╱──────────╲
╱            ╲   Protocol unit tests
╱              ╲  Fast, pure
╱────────────────╲
```

The unit base catches the vast majority of bugs (parser, encoder, decoder,
correlation, keymap engine). The integration layer catches anything that only
shows up against a live tmux. The end-to-end layer catches rendering and
wiring issues across the bridge. Together, they de-risk the entire
integration. Current counts are whatever `pnpm run test:all` reports; the
shape — broad base, narrowing as the stack widens — is what the pyramid
asserts, not specific numbers.

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
