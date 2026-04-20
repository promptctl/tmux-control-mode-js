# Architecture

**Analysis Date:** 2026-04-05

## Pattern Overview

**Overall:** Layered, protocol-driven architecture with strict separation of concerns.

**Key Characteristics:**
- **Three distinct layers**: Transport (spawning), Protocol (parsing/encoding), Client (command correlation)
- **Unidirectional dependencies**: Protocol ← Transport (types only), Client ← Protocol ← Transport
- **Data-flow centric**: Streaming pipeline with minimal branching; variability encoded in data values, not control flow
- **Pure protocol layer**: Zero Node.js dependencies in Protocol—works in browser, Deno, Bun, Node
- **Single enforcer pattern**: Each invariant (command correlation, ID parsing, LF termination) is enforced at exactly one location
- **Immutable message types**: All messages are readonly discriminated unions; no mutations after creation

## Layers

**Transport Layer:**
- **Purpose:** Abstract process management behind a minimal callback-based interface
- **Location:** `src/transport/`
- **Contains:** `TmuxTransport` interface (abstract), `spawnTmux` implementation, process lifecycle
- **Depends on:** Node.js `child_process.spawn` only (in spawn.ts); types layer is Node-agnostic
- **Used by:** TmuxClient exclusively via dependency injection

**Protocol Layer:**
- **Purpose:** Parse tmux control mode wire format into typed messages; encode client commands
- **Location:** `src/protocol/`
- **Contains:** 28 message types, streaming parser, octal decoder, command encoder
- **Depends on:** Nothing (pure TypeScript, works in any JS runtime)
- **Used by:** TmuxClient for parsing/encoding; optionally exported for library consumers
- **Entry points:**
  - `TmuxParser` (streaming parser)
  - Encoder functions (`buildCommand`, `tmuxEscape`, `refreshClientSize`, etc.)
  - Type union `TmuxMessage` and individual message types

**Client Layer:**
- **Purpose:** High-level synchronous command API and event stream over the protocol
- **Location:** `src/client.ts`
- **Contains:** TmuxClient class, command correlation state machine, FIFO queue
- **Depends on:** Transport (injected), Protocol (parser, types, encoder), TypedEmitter
- **Used by:** Library consumers via `src/index.ts` export

**Supporting:**
- **Emitter:** `src/emitter.ts` — Minimal typed event emitter (not Node EventEmitter) with compile-time event name and payload safety
- **Decoder:** `src/protocol/decode.ts` — Converts tmux octal-escaped bytes to Uint8Array; bidirectional with encoder rules

## Data Flow

**Command Execution Pipeline:**

1. **User calls** `client.execute(command)`
2. **TmuxClient creates promise** → pushes `{ resolve, reject }` to FIFO `pending` queue
3. **Encoder formats** command string with LF termination via `buildCommand()`
4. **Transport.send()** → child process stdin
5. **tmux process** → responds with protocol messages on stdout
6. **Transport.onData()** → feeds chunks to parser
7. **Parser.feed()** → buffers and processes complete lines
8. **Parser detects `%begin`** → pops pending entry, creates `inflight` entry with output array
9. **Parser emits all `TmuxMessage` objects** → TypedEmitter distributes to handlers
10. **Non-`%` lines inside response block** → `onOutputLine` callback pushes to `inflight.output`
11. **Parser detects `%end` or `%error`** → resolves promise with `CommandResponse`, clears `inflight`

**State Machine (Command Correlation):**

```
[pending[]] (user calls execute)
    ↓
    (parser sees %begin)
[inflight] (output accumulating)
    ↓
    (non-% lines collected)
    ↓
    (parser sees %end/%error)
[null/resolved] (promise resolved, ready for next)
```

**Event Streaming:**

- All 28 message types emit via `TypedEmitter.emit(msg)`
- Handlers registered via `on(eventType, handler)` or `on("*", wildcardHandler)`
- No guarantee about event ordering relative to command responses (async events fire as tmux sends them)
- Exceptions: response-block guards (`%begin`, `%end`, `%error`) are strictly FIFO-ordered

## Key Abstractions

**TmuxMessage Union:**
- Purpose: Single, exhaustive type for all server-to-client messages (28 variants)
- Examples: `OutputMessage`, `WindowAddMessage`, `SessionChangedMessage`, `CommandResponse`
- Pattern: Discriminated union by `type` field; pattern match on `type` determines available properties
- Location: `src/protocol/types.ts` (lines 230–258)

**TmuxTransport Interface:**
- Purpose: Minimal callback contract for any transport (spawn, WebSocket, IPC, etc.)
- Methods:
  - `send(command: string): void` — Fire-and-forget; no ordering guarantees beyond TCP ordering
  - `onData(callback: (chunk: string) => void): void` — Register data handler; may be called multiple times
  - `onClose(callback: (reason?: string) => void): void` — Register close handler; called once
  - `close(): void` — Disconnect
- Pattern: Callback registration, not EventEmitter; no side effects on construction
- Location: `src/transport/types.ts`

**TmuxParser:**
- Purpose: Streaming, line-oriented parser for the wire protocol
- Invariants:
  - Maintains internal `activeCommandNumber` (state machine for response blocks)
  - Pushes all messages to user callback without filtering
  - Routes output lines to optional `onOutputLine` callback if inside a response block
  - Rejects unknown message types silently (forward-compatible)
- Single entry point: `feed(chunk: string)` — accepts partial or multiple lines
- Location: `src/protocol/parser.ts`

**Command Correlation:**
- Purpose: Match async responses to imperative calls via FIFO ordering
- Invariants:
  - Exactly one `inflight` slot (at most one response being accumulated)
  - Unlimited `pending` queue (unbounded user calls)
  - `%begin` pops from pending; `%end`/`%error` resolves inflight
  - If `%begin` arrives with empty pending queue, it's dropped (misalignment)
- Location: `src/client.ts` (lines 56–57, correlation state; lines 165–202, transitions)

**TypedEmitter:**
- Purpose: Type-safe, generic event emitter without Node.js dependencies
- Supports named events (`on("window-add", handler)`) with compile-time payload types
- Supports wildcard (`on("*", handler)`) for consuming all events as union
- No overrides/removals of handlers—once registered, fires for all matching events
- Location: `src/emitter.ts`

## Entry Points

**Library Entry (`src/index.ts`):**
- Exports: `TmuxClient`, `spawnTmux`, public types (`CommandResponse`, `TmuxMessage`, etc.)
- Purpose: Single, curated public API surface (LAW:one-source-of-truth)
- Non-exported but available via subpath:
  - `@promptctl/tmux-control-mode-js/protocol` → parser, encoder, types
  - `@promptctl/tmux-control-mode-js/terminal` → planned future terminal layer (not yet implemented)

**Application Entry Points:**
- User code: `import { TmuxClient, spawnTmux } from "@promptctl/tmux-control-mode-js"`
- Create transport: `const transport = spawnTmux(["attach-session", "-t", sessionName])`
- Create client: `const client = new TmuxClient(transport)`
- Commands: `await client.execute("list-windows")`
- Events: `client.on("window-add", handler)`

**Protocol-Only Entry:**
- Users who manage transport themselves: `import { TmuxParser } from "@promptctl/tmux-control-mode-js/protocol"`
- Manual parser: `const parser = new TmuxParser((msg) => console.log(msg))`

## Error Handling

**Strategy:** Fail loudly; no silent error absorption.

**Patterns:**

1. **Command Failures:**
   - tmux responds with `%error` guard → parser emits `ErrorMessage`
   - Client resolves promise with `success: false` (same structure as success)
   - Consumer inspects `response.success` and `response.output` (may contain error details from tmux)

2. **Protocol Errors:**
   - Malformed lines (missing fields, parse failures) → skip silently, emit nothing
   - Justification: Protocol is evolving; unknown types should not crash
   - Unknown message types: silently ignored (forward-compatible)
   - Missing required fields: return `null` from per-type parser; not emitted

3. **Transport Errors:**
   - Child process spawn failure → `spawn()` throws immediately (not caught)
   - Child process death → `onClose` callback fires with reason (signal or exit code)
   - No automatic reconnection or queuing

4. **Trust Boundary:**
   - Parser input (tmux stdout): not validated beyond format checks; assumed to be valid protocol
   - User input to `execute()`, `sendKeys()`, etc.: escaped via `tmuxEscape()` (single function, LAW:single-enforcer)
   - Response correlation: guard against empty `pending` queue with `if (entry !== undefined)` (trust boundary defensive check, LAW:no-defensive-null-guards)

## Cross-Cutting Concerns

**Logging:** None built-in; consumers use `on("*", handler)` wildcard to observe all messages.

**Validation:**
- Command arguments escaped at single point: `tmuxEscape()` in `encoder.ts`
- Protocol format validated incrementally as parser reads (e.g., field count checks)
- No pre-flight validation of tmux command syntax; errors caught in `%error` response

**Authentication:** Not applicable; tmux control mode assumes authenticated socket access.

**Timing:**
- No timeouts; response promises wait indefinitely
- Timestamps included in all messages (`timestamp` field) for application-level timing
- No retry logic; user is responsible

**Serialization:**
- Only strings (commands) and Uint8Array (pane output) cross transport boundary
- All command building (encoder.ts) produces UTF-8 valid strings
- All parsing (parser.ts) handles UTF-8 string chunks and produces Uint8Array for binary output

---

*Architecture analysis: 2026-04-05*
