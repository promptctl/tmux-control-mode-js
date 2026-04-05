# Codebase Concerns

**Analysis Date:** 2026-04-05

## Missing Terminal Export

**Issue:** Package.json declares an export for `"./terminal"` but no corresponding implementation exists.

- Files: `package.json` line 15-18
- Impact: Consumers attempting to import from `"tmux-control-mode-js/terminal"` will fail at runtime with a 404 error. This is a breaking API contract.
- Fix approach: Either implement `src/terminal/index.ts` with the promised API, or remove the export declaration from package.json to match the actual codebase structure.

## Uncaught Handler Errors in Event Emitter

**Issue:** Event handlers in `TypedEmitter` are invoked without error boundaries. If a handler throws, it will propagate unchecked.

- Files: `src/emitter.ts` lines 130-136
- Current behavior:
  ```typescript
  for (const handler of set) {
    (handler as (event: TmuxMessage) => void)(event);
  }
  ```
- Impact: A single misbehaving event listener can crash the entire client. Handler errors are not isolated—they can interrupt the flow of subsequent handlers or core client logic. This violates fault isolation boundaries.
- Fix approach: Wrap each handler invocation in try-catch, optionally emitting an "error" event or logging the failure. This allows one broken listener to not break all consumers.

## No Timeout Protection on Command Execution

**Issue:** The `execute()` method in `TmuxClient` creates promises that may never resolve if tmux crashes or becomes unresponsive.

- Files: `src/client.ts` lines 96-101
- Current behavior: A pending command entry sits in the queue indefinitely if the transport closes before a %begin/end pair arrives.
- Impact: Callers can hang indefinitely with no way to timeout. In long-running applications or CI environments, hung promises leak resources and create zombie operations.
- Fix approach: Implement a configurable timeout per command (default: reasonable value like 30s). On timeout, auto-reject the promise with a clear error. Consider exposing timeout via `SpawnOptions` or `TmuxClient` constructor.

## Missing Response Block Correlation Recovery

**Issue:** If a %begin message arrives without a corresponding pending entry (e.g., tmux sends unsolicited commands), the begin is silently skipped.

- Files: `src/client.ts` lines 166-178
- Current behavior: `const entry = this.pending.shift()` may return undefined, and the guard silently returns without emitting an error event.
- Impact: Malformed or out-of-order protocol state is hidden. If tmux sends an unexpected %begin, there's no observable failure—the client silently drops the correlation. This makes debugging protocol issues difficult.
- Fix approach: Emit a warning or error event when a %begin arrives with no pending entry, allowing callers to detect protocol violations or connection corruption.

## No Handler Unsubscription Mechanism

**Issue:** The `subscribe()` and `unsubscribe()` methods in `TmuxClient` are fire-and-forget with no confirmation.

- Files: `src/client.ts` lines 144-150
- Current behavior: `unsubscribe()` sends a command but does not wait for or verify the response.
- Impact: There's no way to confirm whether a subscription was actually removed. If the unsubscribe command fails silently, the client continues receiving updates but the caller has no way to know.
- Fix approach: Make `unsubscribe()` return a Promise<CommandResponse> so callers can verify success. This also allows the API to detect and report failures.

## Handler Invocation Not Isolated from Parser Feed

**Issue:** Calling `parser.feed()` may trigger event handlers synchronously, which can call back into TmuxClient.

- Files: `src/client.ts` line 70 and `src/emitter.ts` lines 127-137
- Current behavior: Handlers are invoked during `handleMessage()`, which is called from `parser.feed()`. A handler calling `client.execute()` will synchronously modify the pending queue while the parser is still active.
- Impact: Re-entrant calls to `execute()` from handlers can corrupt the FIFO queue order if multiple commands are added before the parser finishes processing. While the current code structure may prevent this in practice, it's a fragile synchronous re-entrancy hazard.
- Fix approach: Defer handler invocation via microtask queue (e.g., `queueMicrotask()`) to decouple event dispatch from parser feed. This ensures handlers always run after parser state is stable.

## Incomplete Octal Escape Handling

**Issue:** The `decodeOctalEscapes()` function silently passes through malformed escape sequences.

- Files: `src/protocol/decode.ts` lines 46-56
- Current behavior: If `\` is followed by fewer than 3 digits or non-octal digits, the backslash is treated as a raw byte and passed through as-is.
- Impact: Malformed octal sequences from tmux are not detected or reported. If tmux sends `\999` (invalid octal), it's decoded as raw characters instead of failing. This could mask protocol corruption or tmux bugs.
- Fix approach: Add strict mode flag or validation function that rejects malformed escapes. At minimum, add clear documentation about the lenient behavior.

## No Resource Cleanup on Transport Close

**Issue:** When `transport.close()` is called, any pending command promises never resolve or reject.

- Files: `src/client.ts` lines 156-158 and `src/transport/spawn.ts` lines 51-55
- Current behavior: Transport emits "close" event, which sets `inflight` to null (line 72), but does not reject pending entries in the queue.
- Impact: Any promise returned by `execute()` that hasn't yet been matched to a %begin will hang forever. Callers must implement their own timeout or will leak resources when the client closes.
- Fix approach: On transport close, iterate through the pending queue and reject all outstanding promises with a "connection closed" error.

## Test Coverage Gaps

**Untested areas:**

1. **Handler error scenarios** (`src/emitter.ts`): No tests verify behavior when a handler throws. This leaves error propagation behavior undefined.
   - Files: `src/emitter.ts`
   - Risk: Crashes in production due to unhandled handler errors.
   - Priority: HIGH

2. **Malformed input recovery** (`src/protocol/parser.ts`): Parser gracefully skips unknown types and malformed lines, but there are no tests verifying this robustness or documenting the expectations.
   - Files: `src/protocol/parser.ts` lines 352-362
   - Risk: Undocumented behavior may be accidentally changed, reducing protocol robustness.
   - Priority: MEDIUM

3. **Transport close while commands are pending** (`src/client.ts`): No integration test verifies that pending commands are properly rejected when transport closes.
   - Files: `src/client.ts`
   - Risk: Hidden resource leaks in real-world usage.
   - Priority: HIGH

4. **Re-entrancy from event handlers** (`src/emitter.ts`, `src/client.ts`): No tests verify FIFO order is preserved when handlers call back into the client.
   - Files: `src/emitter.ts`, `src/client.ts`
   - Risk: Command correlation could be silently corrupted under load.
   - Priority: MEDIUM

5. **Edge case: Empty pending queue on %begin** (`src/client.ts`): Current test only verifies happy path; missing explicit tests for the guard at line 170.
   - Files: `src/client.ts` lines 166-178
   - Risk: Mishandling of out-of-sync protocol state goes undetected.
   - Priority: MEDIUM

## Fragile Synchronous Re-entrancy

**Component:** Command correlation in `src/client.ts`

- Files: `src/client.ts` lines 55-57, 165-202
- Why fragile: The FIFO queue and inflight state are modified by `handleMessage()`, which is invoked synchronously during `feed()`. If an event handler (registered via `.on()`) calls `execute()`, it will push a new pending entry while `handleMessage()` is still unwinding. This creates a window of re-entrancy.
- Safe modification: Do not invoke event handlers until after the current `feed()` call completes. Use `queueMicrotask()` to defer handler dispatch.
- Test coverage: Add explicit re-entrancy test: register a handler that calls `execute()`, then feed a complete command response block. Verify that the new command is queued after the current one in FIFO order.

## Spawn Transport Tight Coupling

**Issue:** The `spawnTmux()` function is the only way to instantiate a `TmuxTransport`. It's tightly coupled to Node.js `child_process`.

- Files: `src/transport/spawn.ts` lines 29-84
- Impact: `TmuxClient` claims to be environment-agnostic ("works in browser, Deno, Bun"), but the only transport implementation is Node-only. Trying to use TmuxClient in a browser fails at runtime.
- Fix approach: The interface `TmuxTransport` is portable, but the lack of documented alternatives makes the claim misleading. Either: (a) document that spawn transport is Node-only and that custom transports must implement the interface, or (b) provide a WebSocket transport implementation and document both as supported options.

## Missing Error Signal Path

**Issue:** Protocol-level errors (malformed messages, OOB correlation) have no user-observable signal path.

- Files: `src/protocol/parser.ts` lines 352-362, `src/client.ts` lines 166-178
- Current behavior: Malformed or unexpected messages are silently dropped with no event emitted.
- Impact: Users cannot detect when the protocol stream is corrupted or out of sync. Debugging becomes extremely difficult because failures are invisible.
- Fix approach: Add an "error" or "protocol-error" event type to `TmuxEventMap` and emit it when: (1) an unknown message type is encountered, (2) a %begin arrives with no pending entry, (3) malformed escape sequences are detected. This gives users visibility into protocol issues.

---

*Concerns audit: 2026-04-05*
