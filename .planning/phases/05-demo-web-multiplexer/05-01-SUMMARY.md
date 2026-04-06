---
phase: 05-demo-web-multiplexer
plan: 01
status: complete
date: 2026-04-06
---

# Phase 5 — Summary

## What shipped

A reference web multiplexer at `examples/web-multiplexer/`:

```
Browser (Vite + React + Mantine + xterm.js)        Bridge (Node: ws + http)        tmux
   │    layout:                                       │   spawnTmux + TmuxClient      │
   │    ├─ SessionList (navbar)                       │   forwards all events         │
   │    ├─ WindowTabs + PaneView(s) (main)            │   proxies execute/sendKeys/   │
   │    └─ Debug/Error panels (aside)                 │   detach                      │
   │                                                  │                               │
   └────── WebSocket (JSON, base64 pane bytes) ──────►│ ◄─── -C protocol ────────────►│
```

## Files created (17)

| Path | Purpose |
|------|---------|
| `examples/web-multiplexer/package.json` | Demo-only dependencies (React, Mantine, xterm, ws, vite, tsx) |
| `examples/web-multiplexer/tsconfig.json` | Standalone TS config (no extends) |
| `examples/web-multiplexer/vite.config.ts` | React plugin + WS proxy to bridge |
| `examples/web-multiplexer/index.html` | Vite entry |
| `examples/web-multiplexer/shared/protocol.ts` | WS wire-protocol types (server + browser) |
| `examples/web-multiplexer/server/bridge.ts` | Node bridge — HTTP + WS + TmuxClient |
| `examples/web-multiplexer/web/main.tsx` | React entry, Mantine provider |
| `examples/web-multiplexer/web/App.tsx` | Layout + state orchestration |
| `examples/web-multiplexer/web/ws-client.ts` | Browser WS client with request/response correlation |
| `examples/web-multiplexer/web/state.ts` | Snapshot loader (list-sessions + list-windows + list-panes) |
| `examples/web-multiplexer/web/components/SessionList.tsx` | Session navbar |
| `examples/web-multiplexer/web/components/WindowTabs.tsx` | Window tabs |
| `examples/web-multiplexer/web/components/PaneView.tsx` | Pane grid with xterm.js |
| `examples/web-multiplexer/web/components/DebugPanel.tsx` | Filterable event stream |
| `examples/web-multiplexer/web/components/ErrorPanel.tsx` | Error log |
| Root `package.json` | Added `demo` and `demo:install` scripts |
| `README.md` | Added "Demo" section |

## Key architectural calls

- **One `TmuxClient` per WebSocket connection.** Each browser connection gets its own bridge-side client. No shared state between connections. Simple and avoids cross-talk bugs.
- **Snapshot-based UI state, not event-delta state.** On bridge-ready and on any structural event (`%window-add`, `%layout-change`, etc.) the app re-runs `list-sessions` / `list-windows -a` / `list-panes -a` with `-F` format strings and rebuilds the model. Simpler than maintaining a delta-applied local model, and tmux is the source of truth anyway.
- **Base64 for pane bytes over WebSocket.** `%output` carries `Uint8Array`; JSON can't. The bridge encodes to base64, the browser decodes in `ws-client.decodeBase64`. Could be faster with binary WS frames but this is a demo; clarity wins.
- **Types-only imports across the bridge boundary.** `shared/protocol.ts` and `web/ws-client.ts` use `import type` from the library. The production Vite build strips these entirely — verified by bundle inspection.

## Surprises along the way

1. **Startup handshake eats commands.** If the bridge accepts a command before the `%begin/%end` pair from `attach-session` is consumed, the startup pair steals the response slot and the real command's response is orphaned. Fix: don't send commands until the bridge emits `{kind: "ready"}`, which is gated on `session-changed`. The browser `App.tsx` already waits for `connState === "ready"` before loading the snapshot, so this affects only naive clients.

2. **Format strings must be single-quoted.** `list-sessions -F #{session_id}|#{session_name}` fails with `-F expects an argument`. Quoting `'#{session_id}|#{session_name}'` works. The initial version of `state.ts` had unquoted format strings; smoke test caught it; fixed in `state.ts`.

## Verification

| Check | Result |
|-------|--------|
| `./node_modules/.bin/tsc --noEmit` (demo) | clean |
| `./node_modules/.bin/vite build` | 754 modules, 540 kB bundle, clean |
| Library unit tests (`npx vitest run tests/unit/`) | 157/157 pass |
| Library integration tests (`TMUX_INTEGRATION=1 npx vitest run tests/integration/`) | 19/19 pass |
| Library `npm run build` | clean |
| Bridge end-to-end smoke (`list-sessions`) | returned 21 real sessions from host |
| Browser bundle has no library runtime symbols (`grep TmuxClient dist/assets/*.js`) | no matches ✓ |
| Library `package.json` `dependencies` field | absent (only `devDependencies`) ✓ |

## Not done (intentional)

- No production deployment path (no Dockerfile, no auth). The demo is explicitly a functional example.
- No session-creation UI. Create sessions with `tmux new-session -d -s <name>` and they appear via `%sessions-changed`.
- No pane-splitting UI buttons. `split-window` via tmux keybindings triggers `%layout-change` and the UI updates. If you want buttons, add them.
- No resize propagation from browser → tmux (tmux uses its own sizing based on the server's TTY; the demo doesn't attempt to coordinate).
- Integration tests against the demo itself. The demo is UI code; its validation is "does it render and behave" which is a manual smoke check.

## How to run it

```bash
npm run demo:install   # one-time: installs examples/web-multiplexer deps
npm run demo           # starts bridge (:5174) + vite (:5173); open http://localhost:5173
```

The demo connects to your **existing host tmux server**. Make sure you have at least one session:

```bash
tmux new-session -d -s demo
```
