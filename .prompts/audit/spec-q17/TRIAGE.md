# Audit Triage

Source audit: `.prompts/audit/spec-q17/`
Audit date: 2026-05-24
Source commit at audit time: `1fe97c59058e6dcb1de7e47969f3d06529610cfe`
HEAD at triage time: `c685f82` (master, PR #59 merged)
Total findings in scope (per ticket tmux-audit-x5u.5): 7 (SPEC.md F1+F3+F5+F9+F10, MANIFEST F4+F9)

## Already-applied findings (excluded from scope)

These were applied by prior tickets x5u.2 through x5u.4 and are recorded here for completeness:

- SPEC.md F2 — §7.1 decoder note → **already applied** (x5u.2/x5u.3)
- SPEC.md F4 — §12.1 spawnTmux refusal → **already applied** (x5u.4)
- SPEC.md F6 — §4.3.1 CRLF tolerance → **already applied** (x5u.4)
- MANIFEST F1 through F3, F5, F6, F7, F8, F10 — all applied by x5u.2 through x5u.4

---

## Proposed disposition

### SPEC.md

- **F1** (P2, missing-content): No Library API surface section exists. The library ships
  `TmuxClient`, `SinkRegistry`, `PaneTopologyManager`, `TopologyEpochTracker`, scope
  constructors, `createTextStreamSink`, transport helpers, and a rich event map — none
  documented in SPEC.md.
  - Disposition: **accept**
  - Reason: Major gap. The spec is unusable as a consumer reference without this section.
    Verified: `src/index.ts` exports exactly the surface described in the finding; no prior
    PR applied any Library API section.

- **F3** (P2, inaccurate): §11 Client Size Control lists three `refresh-client -C` forms but
  does not distinguish which is a typed library method (`setSize`) vs. forms requiring raw
  `execute()`. A consumer reading §11 has no idea the library surface exists.
  - Disposition: **accept**
  - Reason: Spot-checked `src/client.ts` — `setSize(cols, rows)` maps to form 1; forms 2
    and 3 (`-C @<window-id>:<width>x<height>` and `-C @<window-id>:`) have no typed wrapper
    and require `execute()`. One sentence annotation resolves this cleanly.

- **F5** (P3, incomplete): §15 Reports mentions `requestReport` but not the tmux 3.5
  version floor. `REQUEST_REPORT_MIN_VERSION` constant exists in `src/tmux-compat.ts`; the spec
  should surface it so consumers understand the compatibility constraint.
  - Disposition: **accept**
  - Reason: The version floor is a real consumer concern; the constant is exported-adjacent
    and findable, but the spec should state it explicitly. Small, bounded edit.

- **F9** (P2, missing-content): §23 "Complete Message Reference" covers only wire-level `%`
  protocol messages. The library emits two synthetic events (`connection-state` with
  `ConnectionState` payload, `reconnected` with no payload) that are invisible in §23.
  - Disposition: **accept**
  - Reason: Verified in `src/emitter.ts` — `TmuxEventMap` includes `connection-state` and
    `reconnected`. These are library-level events with no wire counterpart. A §23.1
    Synthetic Events subsection is the natural home.

- **F10** (P3, incomplete): §9 Client Flags table row for `wait-exit` notes what the flag
  does but does not mention that `detach()` sends the unblocking LF and is the idiomatic
  way to release a `wait-exit`-flagged session.
  - Disposition: **accept**
  - Reason: Spot-checked `src/client.ts` `detach()` — it sends a bare `\n` to the transport.
    The §9 row is the right place for a "see also `detach()`" annotation. One phrase addition.

### SPEC_MANIFEST.md

- **F4** (P2, incomplete): §3 "Control-Mode Lifecycle" lists lifecycle operations but does
  not mention `detach()` as a first-class library operation distinct from `close()`.
  - Disposition: **accept**
  - Reason: Verified `src/client.ts` — `detach()` sends `\n`; `close()` tears down the
    transport. They are semantically different operations. The finding's recommended sentence
    belongs in §3 after the existing `spawnTmux` refusal note.

- **F9** (P2, incomplete): §26 "Client-Session Operations" lists only `refresh-client`
  subcommands. The library's typed surface for pane/window operations
  (`sendKeys`, `splitWindow`, `listWindows`, `listPanes`, `execute`) is entirely absent.
  - Disposition: **accept**
  - Reason: Verified `src/index.ts` and `src/client.ts` — all four typed methods plus
    `execute()` exist and are public. The section title and scope need expansion.

---

## Summary counts

- Accept: 7 (SPEC.md F1, F3, F5, F9, F10 + MANIFEST F4, F9)
- Reject: 0
- Defer: 0
- Needs user input: 0
