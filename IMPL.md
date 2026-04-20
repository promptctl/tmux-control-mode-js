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
│   ├── terminal/          # Terminal integration layer (no hard deps)
│   │   ├── types.ts       # TerminalEmulator interface
│   │   ├── pane-manager.ts # Routes output/input between client and terminals
│   │   └── index.ts       # Re-exports
│   │
│   ├── client.ts          # High-level TmuxClient combining both layers
│   └── index.ts           # Package root
│
├── examples/
│   └── xterm-electron/    # Reference Electron + xterm.js app (see Section 10)
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
    "./terminal": {
      // Terminal integration — TerminalEmulator interface + PaneManager
      // Works anywhere (no Node.js or xterm.js dependency)
      "types": "./dist/terminal/index.d.ts",
      "default": "./dist/terminal/index.js"
    }
  }
}
```

Consumers pick what they need:

```ts
// Electron main process — full client with spawn transport
import { TmuxClient, spawnTmux } from "@promptctl/tmux-control-mode-js";

// Renderer process — terminal integration (PaneManager + interface)
import { PaneManager } from "@promptctl/tmux-control-mode-js/terminal";

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
  subscribe(name: string, what: string, format: string): void;
  unsubscribe(name: string): void;

  // Lifecycle
  close(): void;
}
```

### Response Correlation

The client tracks in-flight commands by `command-number` from `%begin` lines.
`execute()` returns a `Promise<CommandResponse>` that resolves when the
matching `%end` arrives or rejects on `%error`. This is the primary mechanism
for correlating requests with responses.

```ts
interface CommandResponse {
  commandNumber: number;
  timestamp: number;
  output: string[];   // Lines between %begin and %end
  success: boolean;   // true for %end, false for %error
}
```

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

Each tmux pane maps to one xterm.js `Terminal` instance. The data flow:

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
PaneManager (renderer)
  │  looks up Terminal instance for pane %5
  │  calls terminal.write(data)
  ▼
xterm.js Terminal
  │  interprets escape sequences, updates grid
  ▼
Canvas/WebGL render
```

User input flows in reverse:

```
xterm.js Terminal
  │  terminal.onData(data)   // user typed "ls\r"
  ▼
PaneManager
  │  builds: send-keys -t %5 "ls" Enter
  │  or: send-keys -t %5 -l "ls\r" (literal mode)
  ▼
TmuxClient
  │  sends command over transport
  ▼
tmux server
```

### 9.3 Terminal Interface

We define a minimal interface that xterm.js satisfies, rather than depending
on xterm.js directly in the core library. This keeps the core decoupled and
allows other terminal implementations:

```ts
/**
 * Minimal terminal interface. xterm.js Terminal satisfies this out of the box.
 */
interface TerminalEmulator {
  /** Write data to the terminal for rendering */
  write(data: string | Uint8Array): void;

  /** Register callback for user input */
  onData(callback: (data: string) => void): { dispose(): void };

  /** Register callback for terminal resize */
  onResize(callback: (size: { cols: number; rows: number }) => void): { dispose(): void };

  /** Resize the terminal grid */
  resize(cols: number, rows: number): void;

  /** Current dimensions */
  readonly cols: number;
  readonly rows: number;
}
```

xterm.js `Terminal` already implements all of these methods with the same
signatures — no adapter needed.

### 9.4 PaneManager

The `PaneManager` is the glue between `TmuxClient` and terminal instances.
It manages the lifecycle of per-pane terminals:

```ts
class PaneManager {
  constructor(client: TmuxClient, terminalFactory: () => TerminalEmulator);

  /** Get or create a terminal for a pane */
  getTerminal(paneId: number): TerminalEmulator;

  /** Attach a terminal to a DOM element (xterm.js .open()) */
  attach(paneId: number, element: HTMLElement): void;

  /** Detach and dispose a terminal */
  detach(paneId: number): void;

  /** Handle all routing automatically */
  start(): void;
  stop(): void;
}
```

Responsibilities:

- **Output routing:** Listens for `output` / `extended-output` events,
  decodes octal escapes, calls `terminal.write(data)` on the correct instance.
- **Input routing:** Listens for `terminal.onData()`, sends `send-keys`
  commands to the correct pane.
- **Resize propagation:** Listens for `terminal.onResize()`, sends
  `refresh-client -C` with the new size. Handles per-window sizing if
  multiple panes have different dimensions.
- **Lifecycle:** Creates terminals on `%window-add` / first output, disposes
  on `%window-close`.
- **Pause/continue:** When `%pause` arrives, optionally shows a visual
  indicator. When the user scrolls back to the bottom or interacts, sends
  `refresh-client -A %<id>:continue`.

### 9.5 Initial Pane Sync

When a control mode client attaches to an existing session, the panes already
have content. tmux does **not** replay historical output over control mode.
The control client only receives new output from the point of attachment.

To get the current pane content for initial display:

1. Use `capture-pane -p -t %<id>` to capture the current visible grid content
   as text (no escape sequences — just the rendered text).
2. Or use `capture-pane -p -t %<id> -e` to include escape sequences (colors,
   attributes).
3. Write the captured content to the xterm.js instance before starting the
   live output stream.

```ts
async function syncPane(client: TmuxClient, terminal: TerminalEmulator, paneId: number) {
  const response = await client.execute(`capture-pane -p -t %${paneId} -e`);
  if (response.success) {
    terminal.write(response.output.join("\r\n"));
  }
  // Now live output will append naturally
}
```

Limitations: `capture-pane` returns the visible grid only, not scrollback.
For scrollback, use `capture-pane -p -t %<id> -e -S -<lines>`. This is a
design choice — capturing huge scrollback on attach is slow and usually
unnecessary.

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

## 10. Reference Example (`examples/xterm-electron/`)

A minimal but complete Electron app that demonstrates the full integration.
This is not a toy — it's a working tmux client that exercises every layer of
the library, and the test suite runs against it.

### 10.1 Structure

```
examples/xterm-electron/
├── package.json            # Electron + xterm.js deps
├── src/
│   ├── main.ts             # Electron main process
│   │   ├── Spawns tmux -C
│   │   ├── Creates TmuxClient
│   │   └── Sets up IPC bridge
│   │
│   ├── preload.ts          # Exposes IPC bridge to renderer
│   │
│   ├── renderer/
│   │   ├── index.html      # Minimal shell: tab bar + terminal container
│   │   ├── app.ts          # Creates PaneManager, handles layout
│   │   ├── pane-view.ts    # Per-pane xterm.js Terminal + DOM element
│   │   └── tab-bar.ts      # Window/tab switching from tmux notifications
│   │
│   └── shared/
│       └── ipc-channels.ts # Type-safe IPC channel definitions
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

### 10.3 Intentional Limitations

The example is deliberately minimal in UI — it's a proof of integration, not a
polished terminal app. No fancy CSS, no preferences UI, no tmux command
palette. Just enough to prove every protocol path works end-to-end.

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
(`examples/xterm-electron/`). They exercise the full stack: spawn tmux →
parse protocol → render in xterm.js → capture terminal state → verify.

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
