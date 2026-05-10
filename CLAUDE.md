# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

Build / typecheck (both are the same — TypeScript project references require emit):

```
pnpm run build        # tsc --build across protocol, transport, src
pnpm run dev          # tsc --build --watch
pnpm run clean        # tsc --build --clean
pnpm run typecheck    # alias for build; do NOT add --noEmit (breaks project refs)
```

Tests — **agents MUST run the full suite with tmux integration**. `pnpm test` (unit-only) exists for CI hosts without tmux; agents never run in CI, and every agent environment has tmux available, so the canonical command is `test:all`:

```
pnpm run test:all              # unit + integration — USE THIS as an agent
pnpm run test:integration      # integration only; sets TMUX_INTEGRATION=1
pnpm test                      # unit only — CI-skip path, do NOT use to verify work
pnpm run test:watch            # vitest watch
TMUX_INTEGRATION=1 pnpm exec vitest run <path>    # single file
TMUX_INTEGRATION=1 pnpm exec vitest run -t "<name>"  # single test by name
```

Integration tests are gated behind `TMUX_INTEGRATION=1`; individual tests may also probe `tmux -V` and skip if the running tmux lacks a feature they exercise (e.g. `requestReport` needs tmux ≥ 3.5 for `refresh-client -r`). If tmux is missing from an agent's environment, that's a setup bug — stop and report, do not fall back to unit-only.

Lint / format / deps:

```
pnpm run lint           # eslint src/
pnpm run lint:fix
pnpm run format         # prettier --write 'src/**/*.ts'
pnpm run format:check
pnpm run check:deps     # fails if root "dependencies" is non-empty
```

Demo (web-multiplexer workspace):

```
pnpm run demo           # starts bridge + Vite; needs at least one local tmux session
```

## Architecture

Three layers, built as three TS project references and shipped as subpath exports (`.`, `./protocol`, `./terminal` — the last currently planned in `IMPL.md`; verify before referencing):

- `src/protocol/` — **pure**, zero Node.js deps. Parses tmux control-mode lines into a discriminated-union `TmuxMessage`, encodes outbound commands, decodes octal escapes. Usable in browser/Deno/Bun. Declared `"sideEffects": false`.
- `src/transport/` — Node-only. `spawnTmux()` forks `tmux -C` via `child_process`; `TmuxTransport` is the interface every consumer writes against (so tests can substitute a fake transport).
- `src/client.ts` — `TmuxClient` orchestrates transport + parser + `TypedEmitter`. Owns the **sole** command-correlation state (a FIFO of pending promises plus one `inflight` slot matching `%begin`/`%end`/`%error` guard blocks back to their sender).

Public API is declared only in `src/index.ts`; everything else is internal. The browser-side of the demo imports **types only** from this package — all protocol work stays in Node.

### Non-obvious invariants

- **Zero runtime dependencies.** Enforced by `scripts/check-no-deps.mjs` on `prepublishOnly`. Demo-only deps belong in `examples/web-multiplexer/package.json`, never the root.
- **tmux 3.2 is the load-bearing floor** (format subscriptions, pane flow control, `%client-detached`). `requestReport` additionally needs 3.4+/3.5+ — see `README.md` compatibility table.
- **Published package ships `dist/` only** (see `"files"` in `package.json`); never hand-edit `dist/`.
- Notifications never appear inside a `%begin`/`%end` response block — the parser relies on this (see `SPEC_MANIFEST.md` §4).

### Specs

- `SPEC.md` — library spec, derived from tmux 3.7.
- `SPEC_MANIFEST.md` — exhaustive catalogue of tmux control-mode surface with source citations into the tmux C source. Use it as the authoritative reference for protocol shape, notification filtering rules, and backpressure semantics.
- `IMPL.md` — implementation rationale and roadmap.
- `tests/integration/client.test.ts` is the spec-conformance gate: per `README.md`, it asserts at least one observation per major event in `SPEC.md` §23.

### Architectural law markers

Source files tag decisions with `// [LAW:<token>] reason` (e.g. `one-source-of-truth`, `single-enforcer`, `dataflow-not-control-flow`). These are load-bearing — preserve and respect them when editing, and add new ones when a change is influenced by or violates a law.
