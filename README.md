# tmux-control-mode-js

Node.js client for the tmux control mode protocol. Provides streaming access to tmux pane output and state change notifications via a single connection per session.

## Install

```bash
npm install @promptctl/tmux-control-mode-js
```

## Requirements

- Node.js >= 20
- tmux >= 3.2

## Compatibility

Supports **tmux 3.2 and later**. The 3.2 floor is load-bearing: the library
depends on features introduced in that release and cannot function on older
tmux:

- Format subscriptions — `refresh-client -B name:what:format` and the
  corresponding `%subscription-changed` notification (tmux 3.2: *"Add a way for
  control mode clients to subscribe to a format and be notified of changes
  rather than having to poll."*)
- Pane flow control — `refresh-client -A <pane>:<action>`, the `pause-after`
  client flag, and the `%pause` / `%continue` / `%extended-output` notifications
  (tmux 3.2: *"Add support for pausing a pane when the output buffered for a
  control mode client gets too far behind."*)
- `%client-detached` notification (tmux 3.2)

Two features are also exposed by the API but require a newer tmux when
actually called:

- `client.requestReport(...)` — needs tmux **3.3+** (`refresh-client -r`)
- `%config-error` notification — only emitted by tmux **3.4+**

No known breaking changes through tmux 3.7 (the version `SPEC.md` is derived
from).

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
npm install   # once at the repo root — workspaces install demo deps too,
              # still zero runtime deps on this library's package.json
npm run demo  # starts bridge + Vite dev server; open http://localhost:5173
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

The browser imports only TypeScript *types* from `@promptctl/tmux-control-mode-js` — all
protocol parsing and encoding happens in the Node bridge. This proves you can
drive a real web UI with this library without pulling it into the browser
bundle. The demo is not production code (no auth, no multi-user, no
hardening); it exists to validate the library's API and provide an
integration pattern you can copy.

The header toggles between three views, all driven from the same `BridgeClient`:

- **Multiplexer** — the full xterm.js experience: every session, window, and
  pane live, with keystroke forwarding and resize handling. Exercises the
  round-trip input path and pane output rendering.
- **Protocol Inspector** — Wireshark for tmux control mode. Every frame that
  crosses the WebSocket lands in a ring buffer with timing, direction, and
  request/response correlation. Filter by direction, message type, or
  substring; click any row to see decoded payload and jump to its response.
- **Activity Heatmap** — a live grid of every pane in every session, each cell
  glowing in proportion to its current output byte-rate. A decay tick keeps
  quiet panes visible next to loud ones. Click a cell to jump to that pane in
  the multiplexer.
