# Audit Plan — tmux-audit-q17 (Audit 2/4: Spec accuracy)

Source commit: `1fe97c59058e6dcb1de7e47969f3d06529610cfe`
Branch: `audit/spec-accuracy-q17`

## Standing rules for all auditing subagents
- Source of truth is `src/**`. Read source and the single assigned spec. Nothing else.
- **Exception (SPEC.md auditor only)**: may additionally read `tests/integration/client.test.ts` for P0 cross-check, per ticket directive.
- You must NOT Read CHANGELOG, IMPL.md, README.md, design-docs, planning, examples, or any path outside `src/**` and the assigned spec(s).
- You must NOT Edit or Write any file under the repo root other than your one assigned report under `.prompts/audit/spec-q17/`.
- Findings quote spec claims verbatim and cite source as `file:line`.
- Coverage notes are mandatory — empty findings is NOT the same as unchecked.
- For files larger than 1000 lines: either read in full, or explicitly note "grep-sampled only" in Coverage notes with the patterns used.
- If a section has no issues, list it under "Sections with no findings."
- Use the template at `.prompts/audit/spec-q17/AUDIT_TEMPLATE.md` exactly.
- Return when the report is written. Do not summarize — the report IS the deliverable.

## Audit-order rationale
Per skill Phase 5, the project has a layered spec:
- **Inner / granular**: `SPEC_MANIFEST.md` — catalogue of tmux control-mode surface with C-source citations.
- **Outer / consolidated**: `SPEC.md` — library spec derived from tmux 3.7.

SPEC.md is downstream of SPEC_MANIFEST.md, so the manifest is audited first and its report becomes additional input for the SPEC.md audit.

## Checklist

- [x] **1. SPEC_MANIFEST.md audit** → `.prompts/audit/spec-q17/1-spec-manifest.md` ✓ validated (P0=1, P1=0, P2=4, P3=5, +1 source-level note)
  - Source in scope: `src/protocol/**` primarily; `src/client.ts`, `src/transport/**`, `src/connectors/**`, `src/keymap/**`, `src/tmux-compat.ts`, `src/emitter.ts`, `src/connection-state.ts`, `src/errors.ts` as needed.
  - Special instruction: when manifest cites tmux C-source (`tmux/foo.c:NNN`), include the citation verbatim in any related finding; do NOT attempt to verify upstream tmux source.

- [x] **2. SPEC.md audit** → `.prompts/audit/spec-q17/2-spec.md` ✓ validated (P0=0, P1=0, P2=6, P3=6)
  - Source in scope: all of `src/**`.
  - Additional input: the completed `1-spec-manifest.md` report (read it; flag any contradictions between SPEC.md and SPEC_MANIFEST.md that are not already flagged as wrong in the inner report).
  - Permitted extra read: `tests/integration/client.test.ts` ONLY for P0 classification (test-invalidating findings cite the affected test by name + file:line).

- [x] **3. SUMMARY.md** → `.prompts/audit/spec-q17/SUMMARY.md` ✓ written
  - Total findings by severity.
  - Top P0/P1 findings with links to the per-spec reports.
  - Hotspots: spec sections or source modules with the most findings.
  - Source-level bugs surfaced (go to issue tracker, NOT remediation epic).
  - Coverage gaps.

- [x] **4. Remediation epic** (per ticket Acceptance) — `tmux-audit-x5u` (parent invokes `/spec-remediate`), with 6 grouped children `tmux-audit-x5u.1` (P0) … `.6` (P3). Epic + all children ranked to top of backlog via `lit rank … --top` in reverse order. Per-finding granularity was collapsed into per-concern groups (audit reports remain the canonical finding catalogue — [LAW:one-source-of-truth]). Two source-level bugs surfaced are tracked OUTSIDE the epic per skill Phase 6: `tmux-lint-64s`, `tmux-lint-2ee`.

## Validation gates (after each report lands)
1. Spot-check 2–3 findings against the cited source lines.
2. Confirm Coverage notes are complete (any grep-sampling justified).
3. `git status SPEC.md SPEC_MANIFEST.md` must be clean — spec files unmodified.
4. Only then check the item off in this plan.
