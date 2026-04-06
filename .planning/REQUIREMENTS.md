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

- [ ] **CC-01**: `spawnTmux` accepts a `controlControl: boolean` option. `false` → `tmux -C` (default, current behavior). `true` → `tmux -CC`.
- [ ] **CC-02**: In `-CC` mode the transport strips the leading `\033P1000p` (7 bytes) DCS introducer from the read stream before feeding the parser.
- [ ] **CC-03**: In `-CC` mode the transport writes `\033\\` (ST) on `close()` before terminating the process.
- [ ] **CC-04**: Integration test starts a real `tmux -CC` server and round-trips at least one command + one notification successfully.

### Pane Control (SPEC §13)

- [ ] **PANE-01**: `client.setPaneAction(paneId, "on"|"off"|"continue"|"pause")` produces `refresh-client -A %<id>:<action>` and resolves with the response.
- [ ] **PANE-02**: `%pause` and `%continue` notifications are emitted as typed events to subscribers.
- [ ] **PANE-03**: Integration test triggers a real `%pause` from tmux (by setting `pause-after` low) and observes the event.

### Subscriptions (SPEC §14)

- [ ] **SUB-01**: `client.subscribe(name, what, format)` sends `refresh-client -B '<name>':'<what>':'<format>'` and resolves with the response.
- [ ] **SUB-02**: `client.unsubscribe(name)` sends `refresh-client -B '<name>'` (no value) and resolves with the response.
- [ ] **SUB-03**: `%subscription-changed` notifications include the original subscription name; consumers can correlate them by name.
- [ ] **SUB-04**: Integration test creates a subscription, observes at least one `%subscription-changed`, then unsubscribes.

### Client Size (SPEC §11)

- [ ] **SIZE-01**: `client.setSize(width, height)` produces `refresh-client -C <w>x<h>` via the encoder and resolves with the response.
- [ ] **SIZE-02**: Integration test sets a non-default size and verifies tmux acknowledges with success.

### Client Flags (SPEC §9)

- [ ] **FLAG-01**: `client.setFlags(flags: string[])` produces `refresh-client -f <flag>,<flag>` (set) via the encoder.
- [ ] **FLAG-02**: `client.clearFlags(flags: string[])` produces `refresh-client -F <flag>,<flag>` (clear) via the encoder.
- [ ] **FLAG-03**: Integration test sets `pause-after=1` via flags, verifies the flag is observed, clears it.

### Reports (SPEC §15)

- [ ] **REP-01**: `client.requestReport(name)` produces `refresh-client -r <name>` via the encoder and resolves with the response.
- [ ] **REP-02**: Integration test requests a report and observes the response.

### Clipboard Query (SPEC §19)

- [ ] **CLIP-01**: `client.queryClipboard()` produces `refresh-client -l` via the encoder and resolves with the response.
- [ ] **CLIP-02**: Integration test queries the clipboard and verifies success (contents may be empty).

### Flow Control (SPEC §16)

- [ ] **FLOW-01**: `%pause` and `%continue` events are exposed to consumers (covered by PANE-02, restated for traceability).
- [ ] **FLOW-02**: Library documents how to set `pause-after` (via `setFlags`) and the flow-control implications.

### Detach Semantics (SPEC §4.1)

- [ ] **DET-01**: `client.detach()` writes a single `\n` to the transport (the SPEC-defined "detach" trigger) without closing the transport's local handle directly.
- [ ] **DET-02**: `client.close()` (existing) remains the hard-close path that terminates the process.
- [ ] **DET-03**: Integration test calls `detach()` and observes `%exit` from tmux followed by clean transport close.

### Integration Coverage (SPEC §6, §7, §23)

- [ ] **INT-01**: Integration tests cover `%output` (already validated by parser fixtures; assert end-to-end via real tmux).
- [ ] **INT-02**: Integration tests cover `%window-add`, `%window-close`, `%window-renamed`, `%window-pane-changed` triggered by real tmux commands.
- [ ] **INT-03**: Integration tests cover `%session-changed`, `%sessions-changed`, `%session-window-changed` triggered by real tmux commands.
- [ ] **INT-04**: Integration tests cover `%layout-change` triggered by a real `split-window`.
- [ ] **INT-05**: Integration tests cover `%exit` on clean shutdown.
- [ ] **INT-06**: Integration suite is gated by `TMUX_INTEGRATION=1`, runs in CI when tmux is available, and passes 100%.

## v2 Requirements

Deferred — not in scope for this milestone.

### Terminal Integration

- **TERM-01**: `TerminalEmulator` interface for routing pane output to a terminal emulator (xterm.js, etc.)
- **TERM-02**: `PaneManager` for multiplexing multiple panes
- **TERM-03**: Reference Electron + xterm.js example app

### Browser Transport

- **WS-01**: WebSocket transport for browser environments

## Out of Scope

| Feature | Reason |
|---------|--------|
| xterm.js / Electron example | Not part of protocol compliance; pulls in large UI surface |
| Convenience wrappers for arbitrary tmux commands | `client.execute()` already covers this; spec is about control mode, not the tmux command surface |
| Older tmux version compatibility | SPEC.md targets `next-3.7` (commit `5c30b145`) |
| Pre-3.0 protocol quirks | Spec is single-version |

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

**Coverage:**
- v1 requirements: 35 total
- Mapped to phases: 35
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-05*
*Last updated: 2026-04-05 after initial definition*
