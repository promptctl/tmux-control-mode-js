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
