# Audit 2/4 — Spec conformance report

**Ticket:** `tmux-audit-q17`
**Date:** 2026-06-23
**Branch:** `tmux-audit-q17`
**Base:** `c60acbe`
**Specs audited:** `SPEC.md` (1274 lines, §1–§25), `SPEC_MANIFEST.md` (970 lines, §1–§33).
**Source of truth:** tmux C source at `/Users/bmf/code/tmux_tmux` — `git describe` = `3.6a-205-g5c30b145`, `configure.ac` = `next-3.7`, i.e. **exactly the tmux 3.7 the specs derive from**. Man page: source-repo `/Users/bmf/code/tmux_tmux/tmux.1` (8234 lines; the installed `/opt/homebrew/.../tmux.1` is 8007 lines and does **not** line up — see Man-page citations).
**Out of scope:** prose drift (audit 1/4 → `audit/audit-1-doc-drift.md`); comment/`[LAW:]` accuracy (audit 3/4 → `audit/audit-3-comment-law-accuracy.md`); architectural complexity (audit 4/4 → `audit/audit-4-complexity.md`).

This is a **read-only** report. No spec, source, or test file was edited during the audit (`git status` on `SPEC.md SPEC_MANIFEST.md src/ tests/ README.md` was clean after every shard landed). Findings feed the remediation epic `tmux-audit-q17-remediation`.

> **The one question this audit answers:** does the library correctly implement the tmux wire protocol described in `SPEC.md`? **Yes.** Zero conformance bugs. Every finding below is either a spec-accuracy correction (fix the spec, cite the source) or a library-content-relocation (move library notes out of the protocol spec). No library behavior needs to change.

---

## Methodology

Seven read-only subagents, each writing only its own report under `audit/work-q17/` (full detail there; this file consolidates and re-grades):

- **A1–A4** — `SPEC.md` protocol accuracy vs tmux source, sharded §1–6 / §7-notifications / §8–16 / §17–25. Each verified every protocol claim and every `**Source:**` citation against the C source / man page.
- **M** — `SPEC_MANIFEST.md`: mechanical verification of ~150 `file:line` citations (grep the named symbol → compare to cited range).
- **B** — library conformance: `src/protocol/*`, `src/client.ts`, `src/commands/index.ts` vs the protocol behaviors the spec describes (reversed axis — spec is the source of truth, `src/` is the audited artifact).
- **C** — completeness sweep for library-content incursions across both specs (tagged + untagged).

**Adjudication (skill Phase 4).** Every shard was validated by the synthesizing agent: read-only contract confirmed clean, coverage notes checked, and 2–3 findings per shard re-verified against the cited source lines directly. Spot-checks reproduced: A2-F1 (`%output` man mis-cite), A1-F2 (macro NULL conjunct), B (`parseGuard`/`parseExtendedOutput`/`parseSubscriptionChanged` field order), A4-F1 (`client_control_mode` returns `"0"`), A3-F5 (`-CC` raw-mode in `client.c` not `tmux.c`), M-F3 (fg/bg transposed), M-F5 (`cmdq_print` vs `cmdq_error`). All reproduced exactly.

## Severity scheme

- **P0** — test-invalidating: would break or invalidate an assertion in `tests/integration/client.test.ts` (the conformance gate), or reveal the gate is "green for the wrong reason". **None found.**
- **P1** — *wrong*: a flat protocol-fact inaccuracy, **or** a citation that resolves to a **different function/symbol** than named (a remediation agent following it edits the wrong code).
- **P2** — a man-page `tmux.1` citation that lands on the **wrong notification/flag entry** (actively misleading, but secondary evidence and version-unstable), **or** a `(library)` block pending relocation out of the protocol spec.
- **P3** — under-citation: line-range drift onto the **correct** symbol, a missing citation, a paraphrase imprecision, an additive note, or header-tracker trim.

## Headline results

| Axis | Result |
|------|--------|
| **B — library conformance** | **0 conformance bugs.** The library implements every protocol behavior the spec describes, field-for-field against tmux 3.7. The conformance gate passes for the right reason (no assertion contradicts a verified wire format). |
| **A — protocol-fact accuracy** | **2 genuine inaccuracies** (P1): `client_control_mode` false-value; `input_osc_11` bg call-path. The rest of the protocol substance verified clean across all 25 sections. |
| **citation quality** | **4 C-source citations point at the wrong function** (P1); **~12 man-page `tmux.1` citations drifted** (P2/P3), root cause = absolute line numbers vs a moving target. |
| **C — library content in spec** | **14 incursions** (7 in SPEC.md, 6 in SPEC_MANIFEST.md, 3 mirror-pairs) — all relocate-to-IMPL/JSDoc. **`IMPL.md` does not exist yet** and must be created as the relocation home. |

---

## Findings

### P1 — protocol-fact inaccuracies (fix the spec, cite the source)

**Q17-1 · `client_control_mode` false value is `"0"`, not `""`** — `SPEC.md:1155` (§21) claims the value is `"1"` or `""`. `format_cb_client_control_mode` (`format.c:1424-1432`) returns `xstrdup("1")` when `CLIENT_CONTROL` is set and `xstrdup("0")` otherwise; `NULL` only when there is no client (`ft->c == NULL`). The false-case wire value is `"0"`. *(A4-F1)*

**Q17-2 · bg color is not queried by `input_osc_11()` directly** — `SPEC.md:896-905` (§15) and `SPEC_MANIFEST.md:540-543` (§14) describe a symmetric pair: fg via `input_osc_10()`/`input.c:2955`, bg via `input_osc_11()`/`input.c:2999`. The fg path is direct and correct (`input.c:2955` `c = window_pane_get_fg_control_client(wp);`). The bg path is **indirect**: `input_osc_11` calls `window_pane_get_bg(wp)` (`input.c:3005`), and `window_pane_get_bg` (`window.c:1800`) is what calls `window_pane_get_bg_control_client` (`window.c:1805`). `window_pane_get_bg_control_client` is never referenced in `input.c`; cited `input.c:2999` is just `int c;`. *(A3-F9, M-F4)*

### P1 — citations that resolve to the wrong function (fix the citation)

**Q17-3 · `-CC` raw-mode config cited to `tmux.c`, code lives in `client.c`** — `SPEC.md:807` (§12), `SPEC.md:815-816` (§12.1), `SPEC_MANIFEST.md:50` (§2) and `:65-66` (§2.1) all cite `tmux.c:343-362` for the `-CC` terminal raw-mode block (`c_iflag = ICRNL|IXANY`, etc.). `tmux.c:343-362` is `getversion()` + the top of `main()` — none of the cited code. The block is `client.c:344-360` (verified: `client.c:351` `tio.c_iflag = ICRNL|IXANY;`). The **flag values listed are all correct**; only the file:line is wrong, in four places. *(A3-F5, M-F1)*

**Q17-4 · `SPEC_MANIFEST.md` §14 fg/bg function ranges transposed** — `:535-537` pairs `window_pane_get_fg_control_client → window.c:1840-1852` and `..._bg... → 1881-1893`. Source is reversed: bg is at `window.c:1840`, fg at `window.c:1881`. *(M-F3)*

**Q17-5 · `SPEC_MANIFEST.md` §4 `cmdq_print()` cited inside `cmdq_error()`** — `:147-148` cites `cmd-queue.c:881-891` for `cmdq_print()`. `cmdq_print` is `cmd-queue.c:844` (body 843-859); lines 881-891 are inside `cmdq_error()` (def `:863`). *(M-F5)*

**Q17-6 · `SPEC_MANIFEST.md` Invariant 4.1 upstream citation wrong line + misquote** — `:164-165` cites `tmux.1:7896-7897` and quotes "a notification will never occur inside a **response** block". The man text is at `tmux.1:7902` and reads "...inside an **output** block." Wrong line and a paraphrase presented inside quotation marks. This invariant is the named justification for the parser's block-purity branch (`[LAW:one-source-of-truth]`) and the conformance gate's core assumption, so its upstream evidence must resolve exactly. *(M-F2)*

### P2 — man-page `tmux.1` citations landing on the wrong entry

The whole CONTROL MODE man section is shifted relative to the source-repo `tmux.1`; many absolute citations land on the **neighbouring** notification/flag. Representative (all detailed in the shard reports): `%output` cites the `%pane-mode-changed` entry; §11 `-C` cites the `-A` block; §15 `-r` cites the `-l` block; §16.1 "too far behind" cites `%layout-change`; §21 `client_control_mode` cites `window_name`; §25 `%session-renamed` cites a config-file example. *(A2-F1, A3-F6/F7/F8, A4-F2/F3, M-F7)*

**Root cause & durable fix:** absolute `tmux.1:NNNN` line numbers are a representation of "where this entry lives" that silently rots every time upstream reflows the man page (installed 8007 lines vs in-tree 8234). The fix is **not** a one-time renumber (it will rot again) but to cite by **stable anchor** — `.It Ic %session-renamed`, flag name, or section — so the citation can't drift. `[LAW:one-source-of-truth]`

### P2 — library content in the protocol spec (relocate to IMPL.md / JSDoc)

The protocol specs must contain only tmux wire facts; library behavior belongs in `IMPL.md` or source JSDoc. **`IMPL.md` does not exist** (not on disk, not in git) — it is named as the home by CLAUDE.md and by several in-spec notes, and must be created before relocation can land.

**SPEC.md** (7): §4.3.1 "Library parser note: CRLF tolerance" (`:127-140`); §7.1 inline "Library note" (`:316`, *untagged, embedded directly under the `%extended-output` definition — the most misleading kind*); §10.1 "Decoder behavior (library)" (`:740-761`); §11.1 "Library mapping (library)" (`:781-787`); §12.1 "spawnTmux refusal (library)" (`:811-829`); §15.1 "Library note (library)" (`:909-922`); §23.1 "Synthetic Events (library)" (`:1219-1233`). *(C-F1..F7, A3-F1..F4, A4-F5)*

**SPEC_MANIFEST.md** (6): Invariant 4.1 "Library reliance" + "Why named" bullets (`:171-180`, *untagged, embedded in a protocol invariant*); §2.1 "spawnTmux refusal" (`:62-80`); §3.1 "Library parser note: CRLF tolerance" (`:104-117`); §3.2 "Library detach note" (`:119-126`); §9.1 "Decoder corollaries" (`:405-425`); §26.1 "Library typed operations" (`:791-804`). *(C-F8..F13)*

**Mirror pairs** (same library note written into both specs — relocate each pair together into one IMPL.md home to collapse three drifting copies back to one): SPEC.md §10.1 ↔ MANIFEST §9.1; SPEC.md §12.1 ↔ MANIFEST §2.1; SPEC.md §4.3.1 ↔ MANIFEST §3.1.

**Context:** many of these carry "resolves audit finding SPEC.md F2/F4/F6…" tags — they are residue from the **prior, wrongly-framed** audit (epic `x5u`) that *added* library content to a protocol spec. Cleaning them up is exactly why `tmux-audit-q17` was reopened.

### P3 — under-citation / cosmetic

- **C-source range clips onto the correct symbol:** `control_write()` cited `control.c:406-464`, true 404-429 (overshoots into `control_check_age`) *(M-F6)*; `control_start`/`control_stop`/empty-line ranges clip by 1–7 lines *(A1-F4)*; §14 "check functions" excluded from the cited `control.c:1032-1168` (true 849-1168) *(A3-F10)*; §9 octal loop `631-642` vs true `632-647` *(M-F8)*.
- **Missing citation:** §3 Identifier Prefixes has no `**Source:**` block at all (the prefixes themselves are correct — `format.c` `format_cb_*_id`) *(A1-F1)*.
- **Paraphrase imprecision:** §6.1 renders `CONTROL_SHOULD_NOTIFY_CLIENT` as `(c)->flags & CLIENT_CONTROL`, dropping the `(c) != NULL &&` conjunct (`control-notify.c:26-27`) *(A1-F2)*.
- **Man-page line drift onto the right entry:** systematic ~1–5 line low-drift across the remaining §7 citations *(A2-F3, M-F9)*; §19 `-l` overshoot *(A4-F4)*.
- **Additive note:** §5.1 `flags` field — the man page (`tmux.1:7885-7886`) says "currently not used"; the spec correctly follows the C source (`cmd-queue.c:618`, the field *is* used). Optionally note the man page is stale so a future auditor isn't misled into reverting the spec *(A1-F3)*.
- **Header framing:** SPEC.md `:3-11` — keep the protocol-vs-library boundary statement (it prevents future incursions); trim the transient line 11 tracker once the `(library)` blocks are relocated *(C-F14)*.

---

## Conformance evidence (the 0-bug result, explicit)

The library's protocol core was verified field-for-field against tmux 3.7 (full detail in `audit/work-q17/B-library-conformance.md`):

- **Guard framing (§5):** `parseGuard` reads `timestamp commandNumber flags` (3 args, rejects `<3`), matching `cmdq_guard`'s `"%%%s %ld %u %d"` (`cmd-queue.c:832`). Command correlation via FIFO `pending` + single `inflight` slot in `client.ts`; block-purity routed by *position* (any non-terminator line in an open block is output).
- **`%output`/`%extended-output` (§7, §10):** split points (`" "`, `" : "`) and octal decode (`decode.ts` inverts `control.c:631-642` exactly, with the §10.1 noise-tolerance corollaries) all correct.
- **All notifications (§7):** every parser's argument order/count matches the `control-notify.c` emit site (`%subscription-changed` 5-field order with `-`→`-1` sentinel; `%client-session-changed` 3-field order; names-with-spaces preserved via rest-of-line).
- **Outbound encoding (§11/§13/§14/§15):** `refresh-client -C/-A/-B/-r` quoting matches tmux's dequote-then-split parsing; `send-keys -H` hex; `requestReport` version gate.
- **Conformance gate:** no assertion in `tests/integration/client.test.ts` contradicts a verified wire format — green for the right reason.

## Coverage notes

- `SPEC.md` §1–§25: every section read end-to-end and every `**Source:**` citation resolved.
- `SPEC_MANIFEST.md`: ~150 citations; ~all individually opened, with §19/§20/§30/§31 data-structure/helper citations grep-sampled (symbol confirmed present near cited line) — flagged as sampled in `audit/work-q17/M-manifest-citations.md`.
- `src/` protocol core read end-to-end. Ergonomic layers (`topology-router`, `emitter`, `connection-state`, `transport/*`, `connectors/*`) are out of conformance scope (added capability, not protocol).
- **Not deeply audited:** §15.1's "rejected by tmux 3.4" claim was not verified against a tmux 3.4 checkout (only next-3.7 is available); it is a relocation finding regardless.

## Remediation map → `tmux-audit-q17-remediation`

| Ticket | Sev | Action | Findings |
|--------|-----|--------|----------|
| Q17-R1 | P1 | Fix protocol-fact inaccuracies in SPEC.md (via `/spec-remediate`) | Q17-1, Q17-2 |
| Q17-R2 | P1 | Fix wrong/clipped **C-source** `file:line` citations in both specs (via `/spec-remediate`) | Q17-3..6, P3 range-clips, §3 missing cite, macro paraphrase |
| Q17-R3 | P2 | Re-anchor all **man-page** `tmux.1` citations to stable anchors (via `/spec-remediate`) | all P2/P3 man-page drift |
| Q17-R4 | P2 | Create `IMPL.md` as the relocation home | (blocks R5, R6) |
| Q17-R5 | P2 | Relocate **SPEC.md** library content → IMPL.md/JSDoc; trim header tracker | 7 SPEC.md incursions + C-F14 |
| Q17-R6 | P2 | Relocate **SPEC_MANIFEST.md** library content → IMPL.md/JSDoc | 6 MANIFEST incursions |

No library-conformance bug tickets: Axis B found none.
