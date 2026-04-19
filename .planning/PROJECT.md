# tmux-control-mode-js

## What This Is

A JavaScript/TypeScript library that implements the tmux control mode protocol — a faithful, contract-defined wrapper around the wire protocol documented in `SPEC.md`. It lets any Node.js application drive a tmux server (spawn panes, route input, receive structured notifications) without reinventing the parser/encoder. The protocol layer is pure TypeScript and runs in any JS runtime; the transport layer wraps Node's `child_process`.

## Core Value

The library faithfully implements the **tmux control mode protocol** as specified in `SPEC.md` — every server→client message parsed correctly, every client→server command formed correctly, and every protocol behavior (response correlation, DCS framing, flow control, subscriptions, reports) supported. A consumer should be able to use this library without ever reading tmux source.

## Requirements

### Validated

<!-- Inferred from existing code (brownfield baseline). -->

- ✓ All 28 server→client message types defined as discriminated union (`src/protocol/types.ts`) — existing
- ✓ Streaming line-oriented parser with response-block tracking (`src/protocol/parser.ts`) — existing
- ✓ Octal escape decoder for `%output` data (`src/protocol/decoder.ts`) — existing
- ✓ Argument escaper (`tmuxEscape`) and partial command encoder (`src/protocol/encoder.ts`) — existing
- ✓ Node.js spawn transport for `tmux -C` (`src/transport/spawn.ts`) — existing
- ✓ `TmuxClient` with FIFO command/response correlation and typed event emitter (`src/client.ts`) — existing
- ✓ Unit test coverage of parser (17 fixtures), decoder, encoder — existing

### Active

These are the gaps between the current codebase and full `SPEC.md` compliance. Each is verifiable against the spec section noted.

- [ ] **Encoder is the single source of truth for all client→server commands.** `client.ts` currently inlines `refresh-client -C` and `refresh-client -A` strings; consolidate so every command flows through `src/protocol/encoder.ts`. (LAW:one-source-of-truth)
- [ ] **`-CC` DCS-wrapped mode support** (SPEC §2.1, §12). Transport supports both `tmux -C` and `tmux -CC`; in `-CC` mode the client strips leading `\033P1000p` and emits `\033\\` on close.
- [ ] **`refresh-client -A` pane control complete** (SPEC §13). Encoder + client API for setting pane action (`on`/`off`/`continue`/`pause`) — partial today, formalize.
- [ ] **`refresh-client -B` subscriptions complete** (SPEC §14). Subscription lifecycle (subscribe/unsubscribe), `%subscription-changed` correlation back to subscription name.
- [ ] **`refresh-client -C` size control** (SPEC §11). Encoder + client API to set client size; integration-tested against real tmux.
- [ ] **`refresh-client -f` / `-F` client flags** (SPEC §9). API to set/clear `pause-after`, `read-only`, `ignore-size`, etc.
- [ ] **`refresh-client -r` reports** (SPEC §15). API to request reports from tmux.
- [ ] **`refresh-client -l` clipboard query** (SPEC §19). API to request clipboard contents.
- [ ] **`pause-after` flow control wired through client** (SPEC §16). Setting `pause-after=N` and reacting to `%pause`/`%continue` events with a usable client API.
- [ ] **Empty-line detach** (SPEC §4.1). `client.detach()` distinct from `client.close()` — sends `\n` to trigger `CLIENT_EXIT`.
- [ ] **Integration test pass against real tmux** for every notification type in SPEC §23 and every client→server command exposed by the library. Gated by `TMUX_INTEGRATION=1`. This is the machine-verifiable definition of "done."
- [ ] **Demo web multiplexer** — an example web app in `examples/web-multiplexer/` that proves the library integrates cleanly with a real UI: xterm.js terminals, Mantine UI chrome, a small Node.js bridge server consuming `TmuxClient` and forwarding messages to the browser via WebSocket. The library itself remains Node-only with zero UI/Electron dependencies; the demo is a pure consumer.

### Out of Scope

- **Library-level Electron, xterm.js, or UI dependencies** — the library must remain a pure Node.js protocol library. The demo app is a consumer in `examples/`, not part of the library's runtime deps. — *non-negotiable: a UI-agnostic library is the whole point*
- **Generic WebSocket transport in the library itself** — the demo's bridge is specific to the demo. A general-purpose browser transport may come later if a real consumer needs it. — *avoid speculative abstraction*
- **Terminal emulation layer in the library** (`IMPL.md`'s `terminal/` directory, `PaneManager`, `TerminalEmulator` interface) — the demo proves the integration pattern without baking it into the library. — *consumers integrate however they want; the library stays minimal*
- **Production deployment of the demo** — the demo is a functional example, not a deployable product. No auth, no multi-user, no hardening. — *its job is to verify the API, not to be shipped*
- **High-level convenience methods unrelated to control mode** (e.g., wrappers for arbitrary tmux commands beyond what the spec covers). Consumers can call `client.execute("any-tmux-command")`. — *scope is the protocol, not the tmux command surface*
- **Compatibility with tmux older than 3.2** — the library's minimum supported tmux is **3.2** (load-bearing features: subscriptions, pane flow control, `%client-detached`; see README Compatibility section). SPEC.md is derived from `next-3.7` (commit `5c30b145`) but no known breaking changes exist between 3.2 and 3.7 for the wire surface this library uses. Pre-3.2 protocol quirks are out of scope. — *spec is the contract*

## Context

- The tmux control mode protocol is fully documented locally in `SPEC.md` (1163 lines, derived directly from tmux source with line-level citations). It is the single authoritative reference.
- The codebase is well-structured: pure protocol layer (zero Node deps), thin Node transport layer, high-level client. Architectural laws are cited inline in the code (`[LAW:...]` comments). The work ahead is filling gaps inside that structure, not restructuring.
- Substantial unit-test coverage for the protocol layer already exists (951 lines covering 374 lines of parser). The weak point is integration coverage against a real tmux process — only one 179-line integration test exists today.
- `IMPL.md` describes a larger vision (terminal integration, Electron example). That vision is explicitly deferred in favor of completing the protocol library.

## Constraints

- **Tech stack**: TypeScript (ES2022, strict mode, project references), Vitest, Node.js `child_process`. — *already established; no churn*
- **Runtime portability**: `src/protocol/` and `src/transport/types.ts` MUST remain free of Node.js APIs. — *enables browser/Deno/Bun transports later*
- **Spec source of truth**: `SPEC.md` is the contract. Wire format questions are resolved by re-reading the cited section, not by guessing. — *§25 documents one known man-page-vs-code discrepancy; defer to code*
- **Verification**: every protocol behavior MUST be machine-verifiable — either by unit tests against fixtures or by integration tests against a real tmux process (`TMUX_INTEGRATION=1`). User-driven testing is a last resort.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Skip GSD questioning/research stages | Spec exists, codebase mapped, scope is concrete (close gaps to SPEC.md). Ceremony adds paperwork, not signal. | — Pending |
| `SPEC.md` is the contract, not `IMPL.md` or any consumer | A library defined by one consumer is not a library. The protocol spec is the only stable contract. | — Pending |
| Coarse phase granularity (4 phases) | Work is well-scoped and bounded; fine granularity would fragment cohesive changes. | — Pending |
| Defer terminal-integration layer entirely | Out of scope for protocol compliance; pulls in xterm.js, Electron, big surface. Revisit only after the library works. | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-05 after initialization*
