# tmux-control-mode-js — Implementation Notes

> **LIBRARY RATIONALE — the home for "what this library does."**
>
> `SPEC.md` and `SPEC_MANIFEST.md` document the tmux **wire protocol**: what tmux
> emits and accepts, derived from the tmux C source and man page. This file is the
> mirror boundary: it documents what **this library** does *on top of* that protocol
> — decoder tolerances, the typed API surface, synthetic events, version policy, and
> lifecycle. The two are kept separate on purpose so neither drifts into the other.
>
> **Every note here is anchored to a real `src/` symbol.** A library note that names
> code which does not exist is the failure mode that retired the previous `IMPL.md`
> (deleted in `redesign-z31.7`, #73, after it accumulated fiction). If you add a note,
> cite the symbol and file; if the symbol moves or dies, the note moves or dies with it.
> `[LAW:one-source-of-truth]` the code is canonical; this prose is derived and must track it.

Library: tmux control-mode client. Protocol floor: tmux 3.2 (see `README.md`
compatibility table). Implementation layering is described in `CLAUDE.md` →
*Architecture*; this file does not restate it.

---

## Status: relocation home (epic `tmux-audit-a91`)

This file was (re)created by **R4** (`tmux-audit-a91.4`) as the destination for
library-behavior notes that the q17 spec-conformance audit found mis-filed inside the
two wire-protocol specs. **R4 creates the home and the destination map only — it moves
no content.** The sections below are placeholders; **R5** (`tmux-audit-a91.5`, SPEC.md)
and **R6** (`tmux-audit-a91.6`, SPEC_MANIFEST.md) fill the IMPL.md-home sections and add
the JSDoc-home notes, then delete the source `(library)` blocks.

The relocation map (§ *Relocation map* below) is the contract those two tickets
implement. Each note has **exactly one** canonical home — never both IMPL.md *and*
JSDoc — so consolidating the three drifting copies does not mint a fourth.
`[LAW:one-source-of-truth]`

---

## 1. Decisions: where each note lives, and why

The audit recommended "IMPL.md **or** JSDoc" for every note. R4 decides per note using
one principle:

- **Single-symbol behavioral contract → JSDoc at that symbol.** A note that describes
  exactly one function/type's tolerance or output shape belongs next to it, where it
  cannot drift from the code and a reader meets it at the callsite.
  `[LAW:locality-or-seam]`
- **Cross-cutting rationale or a multi-symbol relationship → an IMPL.md section.** A
  policy that spans the library (version floor), a design rationale (`-CC`), a state
  machine (connection lifecycle), or a catalogue (typed-method map) has no single host
  symbol, so its home is here.

IMPL.md remains the navigable index for *both* kinds: JSDoc-home notes appear in the
pointer table (§3) — a reference, not a copy.

---

## 2. IMPL.md-home sections (R5/R6 fill these)

> Placeholders. Each carries the source incursion(s) to relocate and the verified
> src/ anchor. Do not write the body until R5/R6.

### 2.1 Transport & `-CC` rationale
<!-- R5: relocate SPEC.md §12.1 "spawnTmux refusal (library)" -->
<!-- R6: relocate SPEC_MANIFEST.md §2.1 "spawnTmux refusal" (mirror — consolidate here) -->
Why `spawnTmux` drives `tmux -CC` and the library's stance on the upstream
`tcgetattr`-needs-a-tty constraint. Anchor: `spawnTmux` — `src/transport/spawn.ts`.
*(The bare wire fact "`tcgetattr` needs a tty" may remain in SPEC §12 / MANIFEST §2 as
a one-line protocol note with its C-source citation; only the library rationale moves here.)*

### 2.2 Version-compatibility policy
<!-- R5: relocate SPEC.md §15.1 "Library note (library)" -->
The library's version-gating stance: tmux 3.2 floor; features that need newer tmux
(e.g. `requestReport` → `refresh-client -r`, tmux 3.5) degrade or throw rather than
silently no-op. Anchors: `requestReport` — `src/commands/index.ts`; `src/tmux-compat.ts`.
*(A single protocol sentence — "`refresh-client -r` is unrecognized before tmux 3.5" —
may remain in SPEC §15 if anchored to a tmux source/version citation.)*

### 2.3 Synthetic events & connection lifecycle
<!-- R5: relocate SPEC.md §23.1 "Synthetic Events (library)" -->
Library-synthesized events (`connection-state`, `reconnected`) that have **no emit site
in the tmux C source** — they are a library superset over the wire protocol and must not
sit in a wire-message reference. Anchors: `src/connection-state.ts`; `TmuxEventMap` —
`src/emitter.ts`.

### 2.4 Detach vs close
<!-- R6: relocate SPEC_MANIFEST.md §3.2 "Library detach note" (no SPEC.md mirror) -->
The lifecycle distinction between `TmuxClient.detach()` and `TmuxClient.close()` —
detach sends a bare newline with no `%begin`/`%end` correlation and cannot use
`execute()`; close tears down the transport. A two-method relationship, so it lives here
rather than on either method alone. Anchors: `TmuxClient.close` / `TmuxClient.detach` —
`src/client.ts`.

### 2.5 Typed-method API map
<!-- R6: relocate SPEC_MANIFEST.md §26.1 "Library typed operations" -->
The mapping from `TmuxClient` typed methods to the underlying tmux commands they issue.
A catalogue spanning many methods, so it has no single host symbol. Anchor: `TmuxClient`
— `src/client.ts`; `src/commands/index.ts`.

---

## 3. JSDoc-home notes (pointer index — content lives at the symbol)

These notes' canonical home is **source JSDoc**, not this file. Listed here only so the
relocation home is a complete index. R5/R6 write the JSDoc and delete the source block;
do **not** copy the prose into this file.

| Note (audit) | Documents | JSDoc target | Source incursion(s) |
|---|---|---|---|
| Decoder octal tolerance | how `decodeOctalEscapes` tolerates malformed/partial escapes | `decodeOctalEscapes` — `src/protocol/decode.ts` | SPEC §10.1 + MANIFEST §9.1 (mirror) |
| Parser CRLF tolerance | how `feed()` accepts `\r\n` as well as `\n` | `TmuxParser.feed` — `src/protocol/parser.ts` | SPEC §4.3.1 + MANIFEST §3.1 (mirror) |
| Parsed message types | library `output` vs `extended-output` parsed shapes | `OutputMessage` / `ExtendedOutputMessage` — `src/protocol/types.ts` | SPEC §7.1 (untagged, inline) |
| Notification-block reliance | `processLine`'s reliance on "notifications never appear inside `%begin`/`%end`" | `processLine` — `src/protocol/parser.ts` (where `[LAW:one-source-of-truth]` already lives) | MANIFEST Invariant 4.1 "Library reliance" |
| Size-control mapping | how the library maps size control to the `setSize` command | `setSize` — `src/commands/index.ts` | SPEC §11.1 |

> **Precision note for R5/R6:** `setSize` and `requestReport` are **free functions** in
> `src/commands/index.ts`, *not* `TmuxClient` methods — the R5/R6 ticket text says
> "JSDoc on `TmuxClient.setSize`", which would target a method that does not exist. Put
> the JSDoc on the free functions. `close()` and `detach()` **are** `TmuxClient`
> methods (`src/client.ts`).

---

## 4. Relocation map (R5/R6 traceability)

The complete map. Mirror-pairs share one canonical home; both source blocks are deleted
when their shared home is written. Line numbers are from the audit
(`audit/work-q17/C-library-content.md`) and may shift — locate by section heading.

| # | Topic | Canonical home | Source incursion(s) | Ticket |
|---|---|---|---|---|
| 1 | Decoder octal tolerance | JSDoc `decodeOctalEscapes` | SPEC §10.1 ↔ MANIFEST §9.1 | R5+R6 |
| 2 | Parser CRLF tolerance | JSDoc `TmuxParser.feed` | SPEC §4.3.1 ↔ MANIFEST §3.1 | R5+R6 |
| 3 | Parsed message types | JSDoc `OutputMessage`/`ExtendedOutputMessage` | SPEC §7.1 | R5 |
| 4 | Notification-block reliance | JSDoc `processLine` | MANIFEST Invariant 4.1 | R6 |
| 5 | Size-control mapping | JSDoc `setSize` | SPEC §11.1 | R5 |
| 6 | Transport / `-CC` rationale | IMPL.md §2.1 | SPEC §12.1 ↔ MANIFEST §2.1 | R5+R6 |
| 7 | Version-compat policy | IMPL.md §2.2 | SPEC §15.1 | R5 |
| 8 | Synthetic events / lifecycle | IMPL.md §2.3 | SPEC §23.1 | R5 |
| 9 | Detach vs close | IMPL.md §2.4 | MANIFEST §3.2 | R6 |
| 10 | Typed-method API map | IMPL.md §2.5 | MANIFEST §26.1 | R6 |

**Header trim (C-F14), for R5:** keep SPEC.md's protocol-vs-library boundary statement
(it prevents future incursions); after relocation, reduce the transient `(library)`-
tracking sentence to one line: *"Do not add library notes here; they belong in IMPL.md
or JSDoc."* The same applies to any equivalent tracker line in SPEC_MANIFEST.md.

**Epic invariant (do not violate in R5/R6):** fix the spec to match tmux; never weaken
the library or delete a feature to match the spec. Library behavior is **relocated**
here / to JSDoc, never removed. No `src/` behavior change; the conformance gate
(`tests/integration/client.test.ts`, run via `pnpm run test:all`) must stay green.
