# Audit Summary — tmux-audit-q17 (Audit 2/4: Spec accuracy)

- **Source commit:** `1fe97c59058e6dcb1de7e47969f3d06529610cfe`
- **Branch:** `audit/spec-accuracy-q17`
- **Date:** 2026-05-24
- **Specs audited:** `SPEC_MANIFEST.md` (inner / granular), `SPEC.md` (outer / consolidated)
- **Source of truth:** `src/**`
- **Reports:** [1-spec-manifest.md](./1-spec-manifest.md), [2-spec.md](./2-spec.md)

## Totals by severity

| Severity | SPEC_MANIFEST.md | SPEC.md | Total |
|----------|------------------|---------|-------|
| **P0** — test-invalidating | 1 | 0 | **1** |
| **P1** — wrong (contradicts source) | 0 | 0 | **0** |
| **P2** — omission | 4 | 6 | **10** |
| **P3** — under-cited / ambiguous | 5 | 6 | **11** |
| **Totals** | **10** | **12** | **22** |

Plus two source-level notes (the recurring "28 message types" count comment at `src/protocol/types.ts:237`, and an inaccurate "See SPEC.md §12 for details" cross-reference in `src/transport/spawn.ts:111`). These go to the issue tracker, NOT the remediation epic.

## Top findings

### P0 (test-invalidating)

- **MANIFEST F6** — SPEC_MANIFEST §4 (lines 99-100): the invariant *"a notification will never occur inside a response block"* is stated as a two-line parenthetical with a single upstream citation, but `src/protocol/parser.ts:364-388` builds the entire output-vs-event routing on it (with a `[LAW:one-source-of-truth]` marker citing this exact spec passage). If the spec claim is wrong, the conformance test gate is green for the wrong reason. **Recommendation:** promote to a named invariant (e.g., "Invariant 4.1 — Block Purity") so future tmux changes that violate it become a discoverable spec change rather than a silent parser regression.

### P1 (wrong)

- None. Neither spec flatly contradicts source.

### Highest-impact P2 (omissions)

- **SPEC.md F1** — SPEC.md never declares the library's public API surface. Zero hits for any export of `src/index.ts` in SPEC.md. *(This is the largest single omission; F2–F8 below are specific instances of it.)*
- **SPEC.md F9** — `§23 "Complete Message Reference"` omits the two synthetic events the emitter delivers (`connection-state`, `reconnected`). The library exposes them in `TmuxEventMap`; SPEC.md doesn't mention them.
- **SPEC.md F2** — `%output` / `%extended-output` `<value>` documented as octal-escaped, but the library exposes decoded `Uint8Array` (`OutputMessage.data`).
- **SPEC.md F4** — §12 describes `-CC` mode without telling consumers that `spawnTmux` hard-refuses it (`src/transport/spawn.ts:105-113`).
- **SPEC.md F6** — §4.3 documents tmux's "no CR stripping" rule, but the library's parser DOES strip trailing CR for transport-noise resilience (`src/protocol/parser.ts:322-336`).
- **MANIFEST F10** — same `-CC` refusal omission, inner-layer instance.
- **MANIFEST F4** — manifest §3 doesn't mention the library's first-class `detach()` operation which maps to the empty-line wire trigger.
- **MANIFEST F7 / F8** — library-side CR-stripping and control-byte-drop / malformed-escape recovery rules are not catalogued (parallel to SPEC.md F6 / F11).
- **MANIFEST F9** — `sendKeys`, `splitWindow`, etc., not in §26's command catalogue.

### Notable P3 (under-cited / ambiguous)

- **SPEC.md F7** — three `§7.x` notification entries share overlapping `tmux.1:7969-7971` / `tmux.1:7972-7973` man-page line ranges that cannot all be correct. Pure citation hygiene; library code is fine.
- **SPEC.md F8** — `§6.3`'s hook table uses "or" between `%window-close`/`%unlinked-window-close` without cross-referencing `§6.2`'s rule for which one fires. Library exposes both as separate `TmuxMessage` discriminants; integration test had to use `unlinked-window-close` (`tests/integration/client.test.ts:460-477`).
- **SPEC.md F10** — `wait-exit` flag named in §8 / §9 but spec doesn't connect it to the library's `detach()` (which sends the empty-line unblocker).
- **SPEC.md F12** — §6's "(except `%exit`)" parenthetical, plus the library's dual-source `"exit"` emission (wire `%exit` + transport `onClose`), is not documented.
- **MANIFEST F1, F2, F3, F5, F11** — assorted ambiguities and under-citations (subscription-changed field-count subtype lines, session-renamed library-side ground-truth choice, extended-output reserved-field tolerance, `%exit` absent-vs-empty reason, age field unit-at-source).

## Hotspots

- **`§10` Data Encoding / `§9` Data Encoding** (decoder corollaries) — same cluster of three recovery rules (literal-control-byte drop, mid-escape CR skip, malformed-escape `?`) flagged at both layers (MANIFEST F8 ↔ SPEC.md F11).
- **`§12` DCS Wrapping / `§2` DCS Wrapping** (`-CC` refusal) — same omission flagged at both layers (MANIFEST F10 ↔ SPEC.md F4).
- **`§4` / `§3` line reading** — CR-stripping omission flagged at both layers (MANIFEST F7 ↔ SPEC.md F6).
- These three pairs suggest the same drift root: the library's defensive-decoding behavior was added later than the specs were last calibrated, and no remediation pass folded the explanation back into either spec.

The largest single category-level hotspot is **"library API surface absent from SPEC.md"** (SPEC.md F1 plus F3, F4, F5, F9, F10 as instances). SPEC.md is currently a tmux-protocol-derived document; the library's name for its own surface (`TmuxClient`, `spawnTmux`, `TmuxCommandError`, etc.) does not appear in it.

## Source-level bugs surfaced

Per skill Phase 6, separated from spec-remediation findings:

1. **`src/protocol/types.ts:237`** — comment `"Discriminated Union — all 28 server-to-client message types"` includes a count, which is prohibited by `comments-explain-why-only` (the global "no enumerations of callers, counts" rule). The count is currently accurate (28 variants) but is exactly the WHAT-comment that drifts on the next addition/removal. Recent commit `a01fadf` stripped this count across five other sites and missed this one.
2. **`src/transport/spawn.ts:111`** — error message says `"See SPEC.md §12 for details."`, but SPEC.md §12 does not document the `-CC` refusal (per SPEC.md F4). The cross-reference is currently false; remediation must update either the message or the spec section so they align.

Both go to the issue tracker, not the remediation epic.

## Coverage gaps

- **None requiring re-audit.** Every spec section was either read end-to-end or listed in coverage notes with an explicit reason for not being audited (e.g., "tmux C-source internals; no library-visible surface").
- **Tmux-C-source citations not verified upstream.** Per ticket's SPECIAL RULE, the manifest's `tmux/foo.c:NNN` and `tmux.1:NNNN-NNNN` citations were quoted verbatim in findings but not checked against the upstream tmux tree. Findings that depend on such a citation (SPEC.md F7 in particular) flag the file:line so a human can verify mechanically. The audit does not recommend a re-audit pass on this dimension — verification is mechanical given the citation, and the cited line numbers can be re-derived from the SPEC.md commit reference `next-3.7, commit 5c30b145`.
- **`src/connectors/**` and `src/keymap/**`** examined only by grep-sampling. Justified: SPEC.md and SPEC_MANIFEST.md make no claims about these layers. If a future audit aims to cover them, scope expansion is required.

## What to do next

Per skill Phase 7, this audit stops here. The ticket calls for a remediation epic:
- One parent ticket invoking `/spec-remediate` to apply accepted findings.
- One child ticket per non-trivial finding, ranked P0 → P1 → P2 → P3.
- Epic + every child ranked to top of backlog via `lit rank <id> --top`.

The two source-level bugs become separate tickets (issue-tracker class, NOT in the remediation epic).
