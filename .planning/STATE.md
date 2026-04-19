# Project State: tmux-control-mode-js

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-04-05)

**Core value:** Faithfully implement the tmux control mode protocol as documented in `SPEC.md`.
**Current focus:** 0.1.0 release hardening. See `lit ls --topic release` and `lit ls --topic revisit` for the tracked work.

## Current Phase

**Post-phase: 0.1.0 release prep.**
- Status: All SPEC-compliance phases shipped. Remaining work is scoped in the `lit` tracker under the `release` and `revisit` topics.
- Canonical tracker: `lit ls`. Do not reintroduce phase-driven planning for release work.

## Phase Rollup

| # | Phase | Status |
|---|-------|--------|
| 1 | Encoder Consolidation | ✓ Shipped |
| 2 | `-CC` DCS Mode | ✓ Shipped (CC-01 fail-fast, CC-02 DCS stripper; live -CC deferred per CC-04) |
| 3 | refresh-client Surface | ✓ Shipped |
| 4 | Integration Test Pass | ✓ Shipped (19/19 against real tmux 3.6a) |
| 5 | Demo Web Multiplexer | ✓ Shipped (multiplexer + protocol inspector + activity heatmap) |

Per-phase artifacts live in `.planning/phases/<NN>-<slug>/`.

## Workflow Config

- Tracker: `lit` (worktree-native issue tracker). All new work originates there.
- Mode: release
- Granularity: ticket-scoped
- Parallelization: yes
- Research: captured inline on revisit tickets where needed

---
*Last updated: 2026-04-18 after 0.1.0 phase rollup.*
