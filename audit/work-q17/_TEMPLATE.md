# Audit shard: <name>

## Scope
- Spec section(s) / source under audit: <list>
- tmux source of truth: /Users/bmf/code/tmux_tmux (next-3.7 == tmux 3.7) + man page /opt/homebrew/share/man/man1/tmux.1
- Audit axis: A (spec-vs-protocol) | B (library-vs-spec) | C (library-content-in-spec) | M (manifest citations)

## Coverage notes
- Read end-to-end: <list>
- Grep-sampled only: <list + grep patterns + reason>
- Not examined: <list + reason>

## Findings

### F1 — <short title>
- Severity: P0 (test-invalidating) | P1 (wrong / conformance bug) | P2 (omission) | P3 (under-cited / cosmetic / relocation)
- Category: spec-inaccuracy | library-conformance-bug | library-content-in-spec | manifest-citation-error | under-citation | omission
- Axis: A | B | C | M
- Spec location: SPEC.md:<line> or §<n> heading  (or SPEC_MANIFEST.md:<line>)
- Source location: <tmux file.c:line> OR <src/...ts:line>
- Claim under audit: > <verbatim quote from the artifact being audited>
- Reality in source of truth: > <verbatim quote or precise description with citation>
- Fix direction: correct-spec | fix-library | relocate-to-IMPL/JSDoc
- Recommendation: <what should change — DO NOT change it>
- Test impact: <if P0: which assertion in tests/integration/client.test.ts is affected>

### F2 — ...

## Sections with no findings
- <explicit list — empty findings ≠ unchecked>
