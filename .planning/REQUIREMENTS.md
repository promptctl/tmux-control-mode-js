# Requirements: tmux-control-mode-js

**Defined:** 2026-04-05
**Core Value:** Faithfully implement the tmux control mode protocol as documented in `SPEC.md`.

The library is "done" when every requirement below is verified by either a unit test (against protocol fixtures) or an integration test (against a real tmux process via `TMUX_INTEGRATION=1`).

## v1 Requirements

### Encoder Consolidation (SPEC §4, §13–15)

- [ ] **ENC-01**: All client→server command strings are built by functions in `src/protocol/encoder.ts` — `client.ts` contains zero inline command formatting.
- [ ] **ENC-02**: Encoder exports a function for every `refresh-client` flag the library supports: `-A`, `-B` (sub/unsub), `-C`, `-f`, `-F`, `-r`, `-l`.
- [ ] **ENC-03**: All user-supplied arguments pass through `tmuxEscape` exactly once (no double-escaping, no unescaped paths).
- [ ] **ENC-04**: Unit tests assert the exact wire format produced by every encoder function.

### Control Mode Variants (SPEC §2.1, §12)

- [x] **CC-01**: `spawnTmux` accepts a `controlControl: boolean` option. `false` → `tmux -C` (default). `true` → fail-fast with a clear error directing the consumer to use `-C` or supply a PTY-backed transport. *(Rationale: tmux -CC requires PTY-backed stdio, which `child_process.spawn` cannot provide. `-C` and `-CC` carry the identical protocol; `-CC` exists only so terminal emulators can frame the stream within their own escape protocol. A programmatic Node consumer gains nothing from `-CC`.)*
- [x] **CC-02**: `createDcsStripper()` strips the leading `\033P1000p` (7 bytes) DCS introducer, handles fragmented and byte-by-byte arrival, and rejects invalid introducers cleanly. Available as a public export from `src/transport/spawn.ts` for any future PTY-backed transport.
- [x] **CC-03**: When a future PTY-backed transport sets `controlControl: true`, `close()` writes `\033\\` (ST) before terminating. The code path exists in `spawnTmux`'s `close()` (gated by `controlControl`); it is unreachable today because of CC-01's fail-fast guard, but the framing logic is in place for any PTY transport built later.
- [~] **CC-04**: Live integration against `tmux -CC` is **intentionally not implemented** in this milestone. It would require a `node-pty` (or equivalent) dependency, and no consumer of this library needs `-CC` (see CC-01 rationale). The DCS framing logic is fully unit-tested via `createDcsStripper`. *Defer to a future "PTY transport" milestone if a real consumer ever needs `-CC`.*

### Pane Control (SPEC §13)

- [x] **PANE-01**: `client.setPaneAction(paneId, "on"|"off"|"continue"|"pause")` produces `refresh-client -A '%<id>:<action>'` (single quoted token — tmux's parser splits on `:` if unquoted) and resolves with the response. *Phase 3 verification fix: original requirement said unquoted; real tmux requires quoting.*
- [x] **PANE-02**: `%pause` and `%continue` notifications are parsed and emitted as typed events (parser dispatches `pause`/`continue`; `TmuxClient.on("pause", ...)` works).
- [~] **PANE-03**: Direct integration test for `setPaneAction` against real tmux passes. Live `%pause` triggering via `pause-after` is exercised by FLAG-03 round-trip; observing the actual `%pause` notification is best-effort and not asserted (tmux only emits `%pause` when buffered output exceeds the threshold, which depends on host scheduling).

### Subscriptions (SPEC §14)

- [x] **SUB-01**: `client.subscribe(name, what, format)` sends `refresh-client -B '<name>':'<what>':'<format>'` and now resolves with the response (changed from fire-and-forget to awaitable).
- [x] **SUB-02**: `client.unsubscribe(name)` sends `refresh-client -B '<name>'` and resolves with the response (changed from fire-and-forget to awaitable).
- [x] **SUB-03**: `%subscription-changed` carries the original subscription name in its `name` field — already covered by parser (Phase 0 baseline).
- [x] **SUB-04**: Integration test creates a subscription via `client.subscribe(...)` and unsubscribes via `client.unsubscribe(...)`; both round-trip successfully against real tmux.

### Client Size (SPEC §11)

- [x] **SIZE-01**: `client.setSize(width, height)` produces `refresh-client -C <w>x<h>` via the encoder and resolves with the response.
- [x] **SIZE-02**: Integration test calls `setSize(120, 40)` against real tmux and asserts success.

### Client Flags (SPEC §9)

- [x] **FLAG-01**: `client.setFlags(flags: string[])` produces `refresh-client -f <flag>,<flag>` via the encoder. Each flag is a literal name like `"pause-after=2"` or `"no-output"`.
- [x] **FLAG-02**: `client.clearFlags(flags: string[])` produces `refresh-client -f !<flag>,!<flag>` (uses `!` prefix per SPEC §9, not a separate `-F` switch — `-F` is an alias for `-f`).
- [x] **FLAG-03**: Integration test sets `pause-after=2` then clears `pause-after`; both round-trip successfully against real tmux.

### Reports (SPEC §15)

- [x] **REP-01**: `client.requestReport(paneId, report)` produces `refresh-client -r '%<id>:<report>'` (single quoted token, same parser fix as -A) and resolves with the response.
- [x] **REP-02**: Integration test sends an OSC 11 background-color report against an existing pane and asserts success.

### Clipboard Query (SPEC §19)

- [x] **CLIP-01**: `client.queryClipboard()` produces `refresh-client -l` via the encoder and resolves with the response.
- [x] **CLIP-02**: Integration test calls `queryClipboard()` against real tmux and asserts success (contents may be empty in headless environments).

### Flow Control (SPEC §16)

- [x] **FLOW-01**: `%pause` and `%continue` events are exposed to consumers — covered by PANE-02.
- [x] **FLOW-02**: `setFlags(["pause-after=N"])` is the documented way to enable flow control. JSDoc on `setFlags` and `setPaneAction` explains the mechanism. (Detailed README documentation deferred to Phase 4.)

### Detach Semantics (SPEC §4.1)

- [x] **DET-01**: `client.detach()` sends a single `\n` to the transport via the new `detachClient()` encoder function. JSDoc clearly distinguishes it from `close()`.
- [x] **DET-02**: `client.close()` is unchanged — kills the underlying transport.
- [x] **DET-03**: Integration test calls `detach()`, observes `%exit` from tmux, and the transport closes cleanly.

### Integration Coverage (SPEC §6, §7, §23)

- [x] **INT-01**: `%output` round-trip via `send-keys 'echo hello-output' Enter` against real tmux. Asserts a non-empty `Uint8Array` in the next `output` event.
- [x] **INT-02**: `%window-add`, `%window-renamed`, `%unlinked-window-close`, `%window-pane-changed` triggered via `new-window`, `rename-window`, `kill-window`, `select-pane`. *Note on `window-close`: SPEC §6.2 says tmux unlinks the window from the session before the close notification fires, so the receiving client sees the `%unlinked-window-close` variant — both are spec-compliant flavors of "the window is gone."*
- [x] **INT-03**: `%sessions-changed` triggered by a side `tmux new-session -d`. (`%session-changed` is already covered by every `createSession()` helper call which awaits it as part of the handshake.)
- [x] **INT-04**: `%layout-change` triggered by `split-window -h`. Asserts a non-empty layout string.
- [x] **INT-05**: `%exit` triggered by `client.detach()` AND by `client.close()` (covered in two separate tests).
- [x] **INT-06**: Suite gated behind `TMUX_INTEGRATION=1`. `npm run test:integration` runs the suite. README documents how. **19/19 tests pass against real tmux.**

### Demo Web Multiplexer (Phase 5)

A reference consumer app in `examples/web-multiplexer/`. Proves the library integrates cleanly with a UI without forcing UI dependencies into the library.

**Library invariant — non-negotiable:**

- [x] **DEMO-INV**: Library `package.json` has no `dependencies` field at all (only `devDependencies`). All demo deps live in `examples/web-multiplexer/package.json`.

**Bridge architecture:**

- [x] **DEMO-01**: `examples/web-multiplexer/server/bridge.ts` spawns tmux via `spawnTmux(["attach-session"])`, instantiates `TmuxClient`, forwards every TmuxMessage to connected browsers as JSON over WebSocket, and proxies browser commands (`execute`, `sendKeys`, `detach`) to the client. Smoke-tested end-to-end: `list-sessions` returned 21 real sessions from the host tmux server.
- [x] **DEMO-02**: **Verified by bundle inspection:** `grep -l 'TmuxClient\|TmuxParser\|spawnTmux\|refreshClient\|tmuxEscape' dist/assets/*.js` returns no matches. Only `import type` statements from the library cross the browser boundary; the production Vite build strips them entirely.

**Web UI:**

- [x] **DEMO-03**: `examples/web-multiplexer/web/` is a Vite + React + Mantine + xterm.js SPA. Entry is `main.tsx` → `App.tsx` with Mantine `AppShell` layout.
- [x] **DEMO-04**: `SessionList` component shows all sessions from `list-sessions`, highlights the attached one, and switches `activeSession` state on click.
- [x] **DEMO-05**: `WindowTabs` + `PaneView` show windows of the active session and panes of the active window. The active pane has a teal border + "active" badge.
- [x] **DEMO-06**: Clicking a non-active pane sends `select-pane -t <session>:<window>.<pane>` through the bridge. Active pane updates come back through the `%window-pane-changed` event which triggers a snapshot refresh.
- [x] **DEMO-07**: Each pane is an xterm.js `Terminal` instance. `%output`/`%extended-output` events (decoded from base64 in the browser) are written to the matching terminal. Local keystrokes in a focused terminal are forwarded via `client.sendKeys(%<paneId>, data)`.
- [x] **DEMO-08**: Errors from the bridge and from protocol `%error` responses surface in the `ErrorPanel` (a Mantine tab in the right aside). The connection state badge in the header shows connecting/open/ready/closed.
- [x] **DEMO-09**: `DebugPanel` shows the last 200 events, filterable by type (clickable badges). Base64 payloads are truncated to `<N b64 chars>` to keep the panel readable.

**Run experience:**

- [x] **DEMO-10**: `npm run demo` from repo root runs `npm --prefix examples/web-multiplexer run dev`, which uses `concurrently` to start the bridge (`tsx server/bridge.ts`) and Vite (`vite`). Vite proxies `/ws` to the bridge port. Open http://localhost:5173 in a browser. `npm run demo:install` is provided as a one-time install helper.
- [x] **DEMO-11**: README "Demo" section documents `npm run demo:install` + `npm run demo`, explains the bridge architecture, and states clearly that it is not production code.

## v2 Requirements

Deferred — not in scope for this milestone.

### Library Terminal Integration

- **TERM-01**: `TerminalEmulator` interface in the library proper (currently the demo proves the pattern lives outside the library)
- **TERM-02**: Generic browser/WebSocket transport in `src/transport/`

## Out of Scope

| Feature | Reason |
|---------|--------|
| xterm.js / Electron example | Not part of protocol compliance; pulls in large UI surface |
| Convenience wrappers for arbitrary tmux commands | `client.execute()` already covers this; spec is about control mode, not the tmux command surface |
| Compatibility with tmux < 3.2 | Library requires 3.2+ features (subscriptions, pane flow control, `%client-detached`). SPEC.md is derived from `next-3.7`; no known breaking changes in the 3.2–3.7 range for the surface this library uses |
| Pre-3.2 protocol quirks | Below the supported floor |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENC-01 | Phase 1 | Pending |
| ENC-02 | Phase 1 | Pending |
| ENC-03 | Phase 1 | Pending |
| ENC-04 | Phase 1 | Pending |
| CC-01 | Phase 2 | Pending |
| CC-02 | Phase 2 | Pending |
| CC-03 | Phase 2 | Pending |
| CC-04 | Phase 2 | Pending |
| PANE-01 | Phase 3 | Pending |
| PANE-02 | Phase 3 | Pending |
| PANE-03 | Phase 3 | Pending |
| SUB-01 | Phase 3 | Pending |
| SUB-02 | Phase 3 | Pending |
| SUB-03 | Phase 3 | Pending |
| SUB-04 | Phase 3 | Pending |
| SIZE-01 | Phase 3 | Pending |
| SIZE-02 | Phase 3 | Pending |
| FLAG-01 | Phase 3 | Pending |
| FLAG-02 | Phase 3 | Pending |
| FLAG-03 | Phase 3 | Pending |
| REP-01 | Phase 3 | Pending |
| REP-02 | Phase 3 | Pending |
| CLIP-01 | Phase 3 | Pending |
| CLIP-02 | Phase 3 | Pending |
| FLOW-01 | Phase 3 | Pending |
| FLOW-02 | Phase 3 | Pending |
| DET-01 | Phase 3 | Pending |
| DET-02 | Phase 3 | Pending |
| DET-03 | Phase 3 | Pending |
| INT-01 | Phase 4 | Pending |
| INT-02 | Phase 4 | Pending |
| INT-03 | Phase 4 | Pending |
| INT-04 | Phase 4 | Pending |
| INT-05 | Phase 4 | Pending |
| INT-06 | Phase 4 | Pending |
| DEMO-INV | Phase 5 | Pending |
| DEMO-01 | Phase 5 | Pending |
| DEMO-02 | Phase 5 | Pending |
| DEMO-03 | Phase 5 | Pending |
| DEMO-04 | Phase 5 | Pending |
| DEMO-05 | Phase 5 | Pending |
| DEMO-06 | Phase 5 | Pending |
| DEMO-07 | Phase 5 | Pending |
| DEMO-08 | Phase 5 | Pending |
| DEMO-09 | Phase 5 | Pending |
| DEMO-10 | Phase 5 | Pending |
| DEMO-11 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 47 total
- Mapped to phases: 47
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-05*
*Last updated: 2026-04-05 after initial definition*
