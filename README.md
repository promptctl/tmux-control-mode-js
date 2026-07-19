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

> Canonical source for the version constants below: [`src/tmux-compat.ts`](https://github.com/promptctl/tmux-control-mode-js/blob/HEAD/src/tmux-compat.ts).
> This section is the human-readable rationale; the constants there are the
> machine-readable single source of truth (tests import from them).

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

- `requestReport(client, ...)` — needs tmux **3.5+** (`refresh-client -r`; tmux 3.4 rejects the flag as unknown). On older tmux it probes the running version first and rejects with a typed `UnsupportedTmuxVersionError` naming the requirement, instead of leaking tmux's raw flag error.
- `%config-error` notification — only emitted by tmux **3.4+**

No known breaking changes through tmux 3.7 (the version `SPEC.md` is derived
from).

## Idle pane suppression (opt-in)

By default tmux streams output for **every** pane to a control-mode client,
whether or not anything is consuming it. For a client that only watches a few
panes at a time, that is wasted decoding and wire traffic.

Passing `{ idlePaneSuppression: true }` flips on an opt-in layer that pauses any
pane no sink is interested in and resumes it the moment one is:

```ts
const client = new TmuxClient(transport, { idlePaneSuppression: true });

// Every idle pane is paused. Attaching a sink continues exactly the panes its
// scope admits; disposing it re-pauses them when nothing else admits them.
const dispose = client.attachBytesSink(sink, { scope: paneScope(3) });
```

How it works: the library tracks, per pane, the number of attachments whose
scope admits it (`paneScope` + `windowScope` + `sessionScope` + `serverScope`).
When that count crosses 0 ↔ 1 it issues `refresh-client -A <pane>:pause` /
`:continue`. A `serverScope` sink admits every pane, so attaching one keeps
everything live.

- **Default off** — without the option the client behaves exactly as before and
  issues no pause/continue traffic.
- **Per-control-mode-client** — `pause`/`continue` only affect *this* client's
  view. Other tmux clients attached to the same session are untouched.

## Testing

```bash
pnpm test                 # unit tests only (fast, no tmux required)
pnpm run test:integration # integration tests against real tmux
pnpm run test:all         # everything
```

Integration tests are gated behind `TMUX_INTEGRATION=1` so the default test
run is green even on hosts without tmux installed. The integration suite is
the canonical "is this library spec-compliant" check — it exercises every
client method against a real tmux server.

Its conformance gate covers every server→client message in `SPEC.md` §23: each
is either observed live against a real tmux, or carries an in-code exemption
stating why it cannot be provoked deterministically from the test harness. The
`COVERAGE` table in `tests/integration/client.test.ts` is the single source for
that partition — a structural test reconciles it against the SPEC §23 catalogue
and the parser's own message types, so the doc, the parser, and the tests
cannot drift apart, and the gate reddens if any §23 event is left unaccounted.
At present 24 of the 28 events are observed live; the 4 exemptions are the
linked-window `%window-close` variant and the flow-control trio (`%pause`,
`%continue`, `%extended-output`), which require backpressure the harness cannot
create deterministically.

## Demo

`examples/web-multiplexer/` is a reference web multiplexer that exercises the
library end-to-end. It's a Node bridge server (imports `TmuxClient` directly,
spawns your local tmux) plus a browser frontend (React + Mantine + xterm.js)
that talks to the bridge over WebSocket.

```bash
pnpm install   # once at the repo root — workspaces install demo deps; library itself still has zero runtime deps
pnpm run demo  # starts bridge + Vite dev server; open http://localhost:44173
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
