---
phase: 03-refresh-client-surface
plan: 01
status: complete
date: 2026-04-06
---

# Phase 3 — Summary

## What changed

**`src/protocol/encoder.ts`** — added 5 new wire-format builders:

| Function | SPEC | Wire format |
|----------|------|-------------|
| `refreshClientSetFlags(flags)` | §9 | `refresh-client -f <a>,<b>,...` |
| `refreshClientClearFlags(flags)` | §9 | `refresh-client -f !<a>,!<b>,...` |
| `refreshClientReport(paneId, report)` | §15 | `refresh-client -r '%<id>:<report>'` |
| `refreshClientQueryClipboard()` | §19 | `refresh-client -l` |
| `detachClient()` | §4.1 | `\n` (single LF — the SPEC detach trigger) |

Also fixed a wire-format bug in `refreshClientPaneAction`: the `pane-id:action` token must be quoted as a single argument or tmux's parser splits on `:` and rejects with `parse error: syntax error`. Same fix applied to `refreshClientReport`. Discovered via integration test failure.

**`src/client.ts`** — added 6 new public methods, all routed through encoder via `sendRaw`:

| Method | Returns | Behavior change |
|--------|---------|-----------------|
| `setFlags(flags)` | `Promise<CommandResponse>` | NEW |
| `clearFlags(flags)` | `Promise<CommandResponse>` | NEW |
| `requestReport(paneId, report)` | `Promise<CommandResponse>` | NEW |
| `queryClipboard()` | `Promise<CommandResponse>` | NEW |
| `subscribe(name, what, format)` | `Promise<CommandResponse>` | **CHANGED**: was `void` (fire-and-forget). Now awaitable. |
| `unsubscribe(name)` | `Promise<CommandResponse>` | **CHANGED**: was `void`. Now awaitable. |
| `detach()` | `void` | NEW. Sends `\n` (SPEC §4.1 detach signal). |

**`tests/unit/encoder.test.ts`** — 14 new test cases covering all new encoder functions plus the corrected wire format for `refreshClientPaneAction` (quoted token).

**`tests/integration/client.test.ts`** — 7 new integration tests against real tmux, all passing:
- `setSize(120, 40)`
- `setPaneAction(paneId, On)` (with parsed pane id from real `list-panes` output)
- `subscribe` + `unsubscribe`
- `setFlags(["pause-after=2"])` + `clearFlags(["pause-after"])`
- `queryClipboard()`
- `requestReport(paneId, OSC11)`
- `detach()` triggers `%exit` and transport close

## The wire-format discovery

Original `refreshClientPaneAction(0, "on")` produced `refresh-client -A %0:on` — which **looks** correct against the SPEC text. Unit tests passed, but the live tmux test rejected it with `parse error: syntax error`.

Manual investigation against `tmux -C` confirmed: tmux's command parser splits unquoted arguments on `:`, so `%0:on` is parsed as two separate tokens. The fix is to quote the entire pane:action token as a single shell-escaped argument:

```
refresh-client -A %0:on    # ❌ parse error
refresh-client -A '%0:on'  # ✓ accepted
```

The same issue applied to `refresh-client -r %<id>:<report>`. Both encoders now wrap the colon-bearing token in `tmuxEscape(...)`. Unit tests updated to reflect the correct wire format.

**This is exactly why Phase 4 (full integration coverage) exists** — unit tests against assumed wire formats are not enough; the spec must be verified against the real implementation.

## Behavior change worth highlighting

`subscribe` and `unsubscribe` were previously `void` fire-and-forget calls. They now return `Promise<CommandResponse>` so consumers can await the `%end` confirmation before assuming the subscription is active. This is a **breaking change** to the client API surface, but the library has not been published yet, so breaking it now is free.

`%subscription-changed` notifications continue to flow through the typed event emitter (`client.on("subscription-changed", ...)`), independent of the subscribe/unsubscribe acknowledgement.

## Test + build status

- `npx vitest run tests/unit/`: **157 pass / 0 fail** (was 143; +14)
- `TMUX_INTEGRATION=1 npx vitest run tests/integration/`: **11 pass / 0 fail** (was 4; +7)
- `npm run build`: clean

## Requirements coverage

All 16 Phase 3 requirements satisfied. PANE-03 marked partial — the live `%pause` *trigger* depends on host buffering behavior that's fragile to assert; the underlying flow control is exercised end-to-end by FLAG-03 (set/clear `pause-after`) and the `%pause`/`%continue` event delivery is covered by parser fixtures.
