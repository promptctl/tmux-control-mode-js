---
phase: 01-encoder-consolidation
plan: 01
status: complete
date: 2026-04-06
---

# Phase 1 Plan 01-01 — Summary

## What changed

**`src/protocol/encoder.ts`** is now the single source of truth for every client→server command string the library produces.

- Added `sendKeys(target, keys)` — formerly inlined in `client.ts`.
- Added `splitWindow(options)` — formerly inlined in `client.ts`.
- Added and exported `SplitOptions` type — formerly defined in `client.ts`.
- Existing exports unchanged: `tmuxEscape`, `buildCommand`, `refreshClientSize`, `refreshClientPaneAction`, `refreshClientSubscribe`, `refreshClientUnsubscribe`.

**`src/client.ts`** contains zero inline command-string formatting.

- Removed direct `tmuxEscape` import — escaping now happens exactly once, inside encoder functions.
- New private `sendRaw(wire: string)` method takes encoder-produced wire strings (with LF) and feeds them to the same `pending` queue used by `execute()`.
- `execute(command)` now delegates to `sendRaw(buildCommand(command))` — its public contract is unchanged (raw command without LF, gets LF appended). `listWindows`/`listPanes` still use it for fixed verbs.
- `sendKeys`, `splitWindow`, `setSize`, `setPaneAction` now call `sendRaw(encoderFn(...))`.
- `SplitOptions` re-exported from `encoder.ts` to keep `TmuxClient`'s public API surface byte-identical.

**`tests/unit/encoder.test.ts`** adds `describe("sendKeys")` (5 tests) and `describe("splitWindow")` (8 tests) with `.toBe(exactWireString)` assertions per ENC-04.

## sendRaw vs execute split

Two paths into the `pending` correlation queue:

| Path | Input | Used by |
|------|-------|---------|
| `execute(command)` | raw command, no LF | `listWindows`, `listPanes`, public escape hatch for arbitrary commands |
| `sendRaw(wire)` | full wire string with LF | every convenience method (via encoder fn) |

Both push into the same `pending` FIFO and call `transport.send`. `[LAW:single-enforcer]` preserved — there is still exactly one place where command/response correlation happens.

## Requirements verification

| Req | Status | How verified |
|-----|--------|--------------|
| ENC-01 | ✓ | `grep -nE '"(refresh-client\|send-keys\|split-window)\|\`(refresh-client\|send-keys\|split-window)' src/client.ts` exits 1 (no matches) |
| ENC-02 | ✓ | `encoder.ts` exports `sendKeys`, `splitWindow`, plus existing `refreshClientSize`/`-PaneAction`/`-Subscribe`/`-Unsubscribe`. New flags (`-f`/`-F`/`-r`/`-l`) explicitly deferred to Phase 3 per phase scope. |
| ENC-03 | ✓ | `grep -n 'tmuxEscape' src/client.ts` exits 1 (no matches). All escaping happens exactly once, inside encoder functions. |
| ENC-04 | ✓ | `encoder.test.ts` uses `.toBe(exactWireString)` for every encoder function including new `sendKeys` and `splitWindow`. |

## Test + build status

- `npx vitest run`: **133 pass / 0 fail**
- `npm run build`: clean (no TS errors, no warnings)
- `TmuxClient` public method signatures: unchanged

## Commits

- `1618bdb` — docs(01): plan encoder consolidation
- `0195c38` — feat(01): add sendKeys and splitWindow encoders with wire-format tests
- `<this commit>` — refactor(01): route TmuxClient through encoder via sendRaw
