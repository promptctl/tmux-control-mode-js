# Roadmap: tmux-control-mode-js

**Created:** 2026-04-05
**Granularity:** Coarse (4 phases)
**Goal:** Achieve full `SPEC.md` compliance — every protocol behavior implemented and machine-verified.

## Phase Overview

| # | Phase | Goal | Requirements | Plans (est.) |
|---|-------|------|--------------|--------------|
| 1 | Encoder Consolidation | Single source of truth for all client→server commands | ENC-01..04 | 1-2 |
| 2 | `-CC` DCS Mode | Support `tmux -CC` variant with DCS framing | CC-01..04 | 1-2 |
| 3 | refresh-client Surface | Complete pane control, subscriptions, size, flags, reports, clipboard, detach | PANE-01..03, SUB-01..04, SIZE-01..02, FLAG-01..03, REP-01..02, CLIP-01..02, FLOW-01..02, DET-01..03 | 2-3 |
| 4 | Integration Test Pass | Verify every notification + command against real tmux | INT-01..06 | 1-2 |

**Total v1 requirements:** 35
**Coverage:** 100% — every requirement maps to exactly one phase ✓

---

## Phase 1: Encoder Consolidation

**Goal:** `src/protocol/encoder.ts` is the single source of truth for every client→server command string. `client.ts` contains zero inline command formatting and calls only encoder functions.

**Why first:** Phase 3 will add many new commands (`-f`, `-F`, `-r`, `-l`). Doing the cleanup before adding new commands prevents the LAW:one-source-of-truth violation from spreading.

**Requirements:** ENC-01, ENC-02, ENC-03, ENC-04

**Success criteria (observable):**
1. `git grep -nE 'refresh-client|tmuxEscape\\(' src/client.ts` returns zero matches inside command-building expressions (only legitimate imports/calls to encoder functions).
2. Every public command method in `TmuxClient` ultimately calls a function exported from `encoder.ts`.
3. `npm run test` passes; new encoder unit tests assert exact wire format for every encoder function.
4. `npm run build` produces no warnings.

**Touches:** `src/protocol/encoder.ts`, `src/client.ts`, `tests/unit/encoder.test.ts`

---

## Phase 2: `-CC` DCS Mode

**Goal:** Transport supports both `tmux -C` and `tmux -CC` variants. In `-CC` mode the DCS frame (`\033P1000p` ... `\033\\`) is handled transparently — the parser sees clean protocol lines.

**Why second:** It's an isolated transport-layer change with a clear contract; doing it before the wide refresh-client expansion in Phase 3 means Phase 3 integration tests can exercise both modes uniformly.

**Requirements:** CC-01, CC-02, CC-03, CC-04

**Success criteria (observable):**
1. `spawnTmux({ controlControl: true })` spawns `tmux -CC` and the consumer sees identical behavior to `-C` mode (no DCS bytes leak through).
2. Closing a `-CC` client emits `\033\\` (verified via a transport-level unit test with a fake child process).
3. Integration test (`TMUX_INTEGRATION=1`) starts a real `tmux -CC` server, runs `list-windows`, and asserts the response is well-formed.
4. Default behavior (`controlControl` omitted or `false`) is byte-for-byte unchanged from before this phase.

**Touches:** `src/transport/types.ts`, `src/transport/spawn.ts`, `tests/unit/transport.test.ts` (new), `tests/integration/client.test.ts`

---

## Phase 3: refresh-client Surface

**Goal:** Complete the `refresh-client` command surface — pane control, subscriptions, size, client flags, reports, clipboard query, flow control wiring, and detach semantics. Every flag of `refresh-client` mentioned in SPEC §11–§15 and §19 has a corresponding encoder function and `TmuxClient` method.

**Why third:** This is the bulk of the API surface work. It depends on Phase 1 (encoder consolidation) so the new commands land in the right place; it benefits from Phase 2 so integration tests can target either mode.

**Requirements:** PANE-01..03, SUB-01..04, SIZE-01..02, FLAG-01..03, REP-01..02, CLIP-01..02, FLOW-01..02, DET-01..03 (16 total)

**Success criteria (observable):**
1. `TmuxClient` exposes: `setPaneAction`, `subscribe`, `unsubscribe`, `setSize`, `setFlags`, `clearFlags`, `requestReport`, `queryClipboard`, `detach`.
2. Every method has a unit test asserting the wire format it produces.
3. Every method has an integration test (`TMUX_INTEGRATION=1`) that exercises it against a real tmux server and asserts a successful response or expected notification.
4. `client.detach()` and `client.close()` are documented as distinct in JSDoc.
5. All new code cites the relevant `[LAW:...]` and `SPEC §N` it implements.

**Touches:** `src/protocol/encoder.ts`, `src/client.ts`, `src/index.ts` (exports), `tests/unit/encoder.test.ts`, `tests/integration/client.test.ts`

**Splits naturally into 2-3 plans:**
- Plan 3a: Pane control + subscriptions + size + detach (the "core" set)
- Plan 3b: Client flags + reports + clipboard query (the "extended" set)
- Plan 3c: Integration tests for everything in 3a/3b (could fold into 3a/3b or stand alone)

---

## Phase 4: Integration Test Pass

**Goal:** Every notification type listed in SPEC §23 and every command method on `TmuxClient` is exercised by at least one integration test against a real tmux process. The integration suite is the canonical "is this library spec-compliant" check.

**Why last:** Phases 1–3 add tests for the work they do; this phase fills any remaining notification-coverage gaps and produces a single passing suite that defines "done."

**Requirements:** INT-01, INT-02, INT-03, INT-04, INT-05, INT-06

**Success criteria (observable):**
1. `TMUX_INTEGRATION=1 npm test` runs and passes 100% on a host with tmux installed.
2. Every notification type in SPEC §23 has at least one integration test that observes it (auditable via test name → SPEC section mapping).
3. CI is configured to run integration tests when tmux is available; a documented skip path when it isn't.
4. README documents how to run integration tests and what `TMUX_INTEGRATION=1` does.
5. The library can be `npm pack`'d and consumed by an external project as a final smoke check.

**Touches:** `tests/integration/`, `package.json` (scripts), `README.md`, possibly CI config

---

## Dependencies

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4
   (encoder)    (DCS)      (surface)    (verify)
```

Phase 1 must precede Phase 3 (encoder consolidation). Phase 2 is technically independent of Phase 1 but is sequenced before Phase 3 so that the integration tests added in Phase 3 can target either mode.

---

## Definition of Done (Milestone)

When all 4 phases are complete:

- ✓ Every server→client message in SPEC §23 is parsed correctly (already validated by unit tests; re-verified by integration tests in Phase 4)
- ✓ Every client→server command described in SPEC §13–§15, §19 has an encoder function and a client method
- ✓ Both `-C` and `-CC` mode variants work end-to-end
- ✓ Integration suite passes 100% against real tmux
- ✓ A consumer can `npm install tmux-control-mode-js` and use it without reading tmux source

---
*Roadmap created: 2026-04-05*
