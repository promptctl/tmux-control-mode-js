---
phase: 02-cc-dcs-mode
plan: 01
status: complete
date: 2026-04-06
---

# Phase 2 Plan 02-01 — Summary

## What changed

**`src/transport/spawn.ts`**

- Added `DCS_INTRODUCER` (`\u001bP1000p`, 7 bytes) and `DCS_TERMINATOR` (`\u001b\\`, 2 bytes) constants per SPEC §12.
- Added exported `createDcsStripper()` factory: stateful, pure-function stripper that handles unfragmented, fragmented, and byte-by-byte arrival of the introducer. Rejects malformed introducers with a clear error.
- Wired stripper into the `child.stdout` data path, gated on `controlControl: true`.
- Wired DCS terminator emission into `close()`, also gated on `controlControl: true`.
- **Added a fail-fast guard** in `spawnTmux`: when `controlControl: true` is requested, throw a clear error explaining that PTY-backed stdio is required, that `-C` carries the identical protocol, and pointing the consumer at SPEC §12 for the rationale.

**`tests/unit/transport.test.ts`** (new)

- 8 tests covering `createDcsStripper`: happy path, multi-chunk, fragmented introducer, byte-by-byte arrival, invalid introducer rejection, post-rejection silence, empty trailing chunk, immediately-followed-by-empty-remainder.
- 2 tests covering the `spawnTmux` controlControl guard.

**`.planning/REQUIREMENTS.md`**

- CC-01..CC-03 marked complete.
- CC-04 marked **intentionally not implemented** with rationale (see below).

## The discovery that changed the plan

The original plan (committed as `925a921`) called for a live integration test against `tmux -CC`. When I implemented it, the test hung at the 15s timeout. Manual reproduction:

```
$ tmux -CC attach-session -t foo < /dev/pipe
tcgetattr failed: Inappropriate ioctl for device
```

**Root cause:** `tmux -CC` calls `tcgetattr()` on its stdin during startup (SPEC §12: "the terminal is configured in raw mode (tmux.c:343-362)"). This requires stdin to be a **PTY**, not a pipe. `child_process.spawn` provides only pipes, so `tmux -CC` exits immediately on startup. There is no way for `spawnTmux` to launch a working `-CC` process without a PTY library like `node-pty`.

## The deeper question

Why does iTerm2 use `-CC` if `-C` provides the same functionality? Because iTerm2 is a *terminal emulator*: when it runs `tmux -CC`, tmux is attached to iTerm2's own PTY, and the tmux protocol bytes are mixed into the same byte stream as everything else iTerm2 might receive. The DCS wrapper (`\033P1000p ... \033\\`) is a **multiplexing marker** that lets iTerm2 detect "tmux mode starts here, ends there." Without it, iTerm2 couldn't tell tmux protocol from any other escape sequence.

For a programmatic Node consumer (us), we have a *dedicated* stdout fd from `child_process.spawn`. We already know every byte on that fd is tmux protocol. The DCS frame is pure overhead with zero functional benefit. **`-C` and `-CC` carry the identical protocol.**

## The decision

After surfacing this to the user, the chosen path was: ship the spec-correct framing pieces (stripper + terminator) but make `spawnTmux` fail fast on `controlControl: true` rather than pretend it works. The library is spec-correct at the protocol layer; the bundled spawn helper handles the case any programmatic client (including the future demo bridge server) actually needs.

If a real consumer ever needs `-CC` runtime support, the framing primitives are ready — they just need to be wired into a PTY-backed transport built on `node-pty` or similar. That work is deferred to a future milestone.

## Requirements verification

| Req | Status | How verified |
|-----|--------|--------------|
| CC-01 | ✓ done (with guard) | `spawnTmux` accepts the option; `controlControl: true` throws a clear error. Unit-tested. |
| CC-02 | ✓ done | `createDcsStripper` covered by 8 unit tests including fragmentation and rejection. |
| CC-03 | ✓ done (code path exists) | Terminator emission lives in `close()` gated on `controlControl`. Unreachable today via `spawnTmux` (fail-fast guard) but ready for any PTY transport built later. |
| CC-04 | ~ intentionally not implemented | Live integration would require `node-pty`. No consumer needs `-CC`. DCS logic is fully unit-tested. Documented as not-needed in REQUIREMENTS.md. |

## Test + build status

- `npx vitest run tests/unit/`: **143 pass / 0 fail** (was 133; +10 from new transport.test.ts)
- `npm run build`: clean

## Commits

- `925a921` — docs(02): plan -CC DCS mode
- `<this commit>` — feat(02): DCS framing primitives + spawnTmux fail-fast on -CC
