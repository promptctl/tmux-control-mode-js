# Audit: <repo-relative spec path>

## Scope
- Spec file: `<repo-relative path, e.g. SPEC.md>` — use repo-relative paths only; do not include absolute filesystem prefixes.
- Source modules in scope: <list>
- Source commit SHA: 1fe97c59058e6dcb1de7e47969f3d06529610cfe
- Audit date: 2026-05-24
- Ticket: tmux-audit-q17 (Audit 2/4: Spec accuracy)

## Coverage notes
- Modules read end-to-end: <list>
- Modules grep-sampled only: <list with reason and grep patterns used>
- Modules not examined: <list with reason>
- Spec sections examined: <list — record every numbered section reviewed, with one-line per-section outcome>
- Spec sections NOT examined: <list with reason — empty findings is NOT the same as unchecked. If every section was examined, write "none">.

## Findings

### F1 — <short title>
- Severity: P0 (test-invalidating) | P1 (wrong / contradicts source) | P2 (omission) | P3 (under-cited / ambiguous)
- Category: factual-error | omission | stale-api | ambiguity | contradicts-other-spec | under-cited
- Spec location: <file>:<line> or `## Section heading`
- Source location: <file>:<line> (the canonical truth)
- Claim in spec:
  > <verbatim quote of the spec's claim>
- Reality in source:
  > <verbatim quote of the source, OR precise description with file:line>
- Conformance-test impact (P0 only): <test name and file:line in tests/integration/client.test.ts that would be invalidated or is currently green for the wrong reason>
- Recommendation: <what the spec should say — DO NOT change it here>

### F2 — ...

## Sections with no findings
- <list each spec section/heading explicitly examined and found accurate. Empty findings ≠ unchecked.>

## Source-level bugs surfaced (separate from spec findings)
- <If during the audit you noticed src/ doesn't match its own internal contracts (e.g., a doc comment contradicts code), record here. These go to the issue tracker, NOT the remediation epic.>
