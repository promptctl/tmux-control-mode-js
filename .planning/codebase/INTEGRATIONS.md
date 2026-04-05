# External Integrations

**Analysis Date:** 2026-04-05

## APIs & External Services

**tmux:**
- Tmux terminal multiplexer (via spawned process)
  - Integration: Child process communication in control mode (`-C` or `-CC` flags)
  - Communication: stdin/stdout text protocol with LF line termination
  - Config: `tmuxPath` option (default: "tmux" in PATH)
  - Implementation: `src/transport/spawn.ts` → `spawnTmux()`

## Data Storage

**Databases:**
- None - This is a protocol client library, not a stateful service

**File Storage:**
- Local filesystem (socket paths)
  - Option: `socketPath` passed to `spawnTmux()` for tmux socket location
  - Usage: `-S` (absolute path) or `-L` (socket name) to tmux binary
  - No persistent storage in library itself

**Caching:**
- None - All state is transient (FIFO command queue in `TmuxClient`)

**In-Memory State:**
- `TmuxClient` maintains:
  - Pending command queue (`pending: PendingEntry[]`) — commands awaiting response
  - One inflight slot (`inflight: InflightEntry | null`) — current executing command
  - Handlers for output lines and messages
  - Event subscriber registry (in `TypedEmitter`)

## Authentication & Identity

**Auth Provider:**
- None - Direct process spawning with inherited environment
- Socket access control enforced by tmux itself (filesystem permissions on socket)
- Credentials: Optional `env` parameter to inherit/override environment variables passed to spawned tmux process

## Monitoring & Observability

**Error Tracking:**
- None - Errors surface through `CommandResponse.success: false` or Promise rejection
- tmux process errors/signals forwarded to `onClose()` callback with reason string

**Logging:**
- None in library — consumers implement logging via event listeners
- Available events: `TmuxEventMap` includes all 28+ message types from tmux
  - Use `client.on("*", handler)` to observe all messages
  - Use typed `client.on("window-add", handler)` for specific events

**Debug Support:**
- Process stdio: stderr routed to `/dev/null` in spawn options
- stdout only captured and parsed
- Source maps available in distribution (TypeScript `sourcemap: true` option)

## Communication Protocol

**Protocol Type:** Proprietary text-based line protocol (tmux control mode)

**Message Format:**
- Request: Commands sent as raw strings terminated with `\n`
  - Format: tmux command syntax (e.g., `list-windows`, `send-keys -t ... -l ...`)
  - Encoding handled by `src/protocol/encoder.ts` functions
  - Example: `buildCommand()`, `tmuxEscape()` for shell escaping

- Response: Multi-line text with specific message guards
  - Guard format: `%begin <timestamp> <commandNumber> <flags>`
  - Message types: 28 distinct server-to-client message types (see `TmuxMessage` union)
  - Examples: `%window-add <id>`, `%subscription-changed ...`, `%output <paneId> ...`
  - Decoded by `src/protocol/parser.ts` and `src/protocol/decode.ts`

**Data Encoding:**
- Octal escape sequences for binary data in control mode
  - Decoder: `decodeOctalEscapes()` in `src/protocol/decode.ts`
  - Pane output contains raw bytes as `Uint8Array` in `OutputMessage` / `ExtendedOutputMessage`

## Webhooks & Callbacks

**Incoming:**
- None - Library is a client (tmux is the server)

**Outgoing:**
- None - Event-driven model only (observers via `TypedEmitter`)
- Transport callbacks:
  - `transport.onData(callback)` — raw data from tmux stdout
  - `transport.onClose(callback)` — connection closed/error
  - These are internal to `TmuxClient` initialization

## Event Stream

**Subscription System:**
- Fire-and-forget subscriptions (no state tracking)
  - `client.subscribe(name, what, format)` → sends `%refresh-client-subscribe` command
  - `client.unsubscribe(name)` → sends `%refresh-client-unsubscribe` command
  - Events emitted on `TmuxEventMap` as they arrive from tmux

**Supported Events (28 message types):**
- Command responses: `begin`, `end`, `error`
- Pane I/O: `output`, `extended-output`, `pause`, `continue`, `pane-mode-changed`
- Window lifecycle: `window-add`, `window-close`, `window-renamed`, `window-pane-changed`
- Unlinked windows: `unlinked-window-add`, `unlinked-window-close`, `unlinked-window-renamed`
- Layout: `layout-change`
- Session events: `session-changed`, `session-renamed`, `sessions-changed`, `session-window-changed`
- Client events: `client-session-changed`, `client-detached`
- Paste buffers: `paste-buffer-changed`, `paste-buffer-deleted`
- Subscriptions: `subscription-changed`
- Messages: `message`, `config-error`, `exit`

## Process Management

**Child Process Details:**
- Binary: configurable via `tmuxPath` (default: `"tmux"`)
- Stdio:
  - stdin: pipe (commands written here)
  - stdout: pipe UTF-8 (responses read from here)
  - stderr: ignored (`/dev/null`)
- Environment: inherited or overridden via `env` option
- Signal handling: On `SIGTERM` / exit, `onClose()` callback triggered with reason
- Implementation: `src/transport/spawn.ts`

## Configuration Parameters

**Spawn Options (SpawnOptions):**
```typescript
interface SpawnOptions {
  readonly tmuxPath?: string;        // Path to tmux binary (default: "tmux")
  readonly socketPath?: string;      // Socket name or path (→ -L or -S flag)
  readonly env?: Record<string, string | undefined>;  // Environment variables
  readonly controlControl?: boolean; // Use -CC mode instead of -C (default: false)
}
```

**Command Options (SplitOptions example):**
```typescript
interface SplitOptions {
  readonly vertical?: boolean;  // -v (vertical) vs -h (horizontal)
  readonly target?: string;     // -t <target> pane/window
}
```

---

*Integration audit: 2026-04-05*
