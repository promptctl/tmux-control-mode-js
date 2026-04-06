# tmux-control-mode-js

Node.js client for the tmux control mode protocol. Provides streaming access to tmux pane output and state change notifications via a single connection per session.

## Install

```bash
npm install tmux-control-mode-js
```

## Requirements

- Node.js >= 20
- tmux >= 3.2

## Testing

```bash
npm test                # unit tests only (fast, no tmux required)
npm run test:integration # integration tests against real tmux
npm run test:all         # everything
```

Integration tests are gated behind `TMUX_INTEGRATION=1` so the default test
run is green even on hosts without tmux installed. The integration suite is
the canonical "is this library spec-compliant" check — it exercises every
client method against a real tmux server and asserts at least one
notification observation per major event in `SPEC.md` §23.

## Demo

`examples/web-multiplexer/` is a reference web multiplexer that exercises the
library end-to-end. It's a Node bridge server (imports `TmuxClient` directly,
spawns your local tmux) plus a browser frontend (React + Mantine + xterm.js)
that talks to the bridge over WebSocket.

```bash
npm run demo:install   # first time only — installs demo-only dependencies
                       # under examples/web-multiplexer (zero runtime deps
                       # are added to this library's package.json)
npm run demo           # starts bridge + Vite dev server; open http://localhost:5173
```

The demo connects to your **existing host tmux server** and shows every
session you already have — click one in the sidebar to switch to it, and the
control client will also switch its attached session so notifications follow
your focus. The only requirement is that tmux must have at least one session
(otherwise `attach-session` fails at startup). If your tmux has zero
sessions, create one first:

```bash
tmux new-session -d -s demo
```

The browser imports only TypeScript *types* from `tmux-control-mode-js` — all
protocol parsing and encoding happens in the Node bridge. This proves you can
drive a real web UI with this library without pulling it into the browser
bundle. The demo is not production code (no auth, no multi-user, no
hardening); it exists to validate the library's API and provide an
integration pattern you can copy.
