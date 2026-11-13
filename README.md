# tmux-control-mode-js

Node.js client for the tmux control mode protocol. Provides streaming access to tmux pane output and state change notifications. One connection can watch a whole server without disturbing it — see [Watching a whole server](#watching-a-whole-server).

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

Some features are also exposed by the API but require a newer tmux when
actually called:

- `queryClipboard(client)` — needs tmux **3.3+** (`refresh-client -l`; on tmux 3.2 the control client exits, dropping the connection). On older tmux it rejects with `UnsupportedTmuxVersionError` before sending anything.
- `requestReport(client, ...)` — needs tmux **3.5+** (`refresh-client -r`; tmux 3.4 rejects the flag as unknown). On older tmux it probes the running version first and rejects with a typed `UnsupportedTmuxVersionError` naming the requirement, instead of leaking tmux's raw flag error.
- `newWindow()` with a `cwd` that does not exist starts the pane in `$HOME` rather than rejecting, except on tmux **3.3**, where a spawn bug leaves it in the tmux server's own cwd (while `$PWD` still says `$HOME`).
- `paneCwd(client, paneId)` — needs tmux **3.7+**. It reads the directory the pane's foreground process is in, so straight after `newWindow()` it returns the requested cwd with symlinks resolved (on macOS, `/tmp/x` reads back as `/private/tmp/x`), or tmux's fallback (`$HOME`, or `/` when that is missing too) when that directory is missing. A shell whose startup files `cd` elsewhere can move it before the read. When tmux cannot read the cwd (a dead pane, or a child that has not taken its pty yet) it rejects with `PaneCwdUnavailableError`. Before 3.7, tmux forks the pane before the child changes directory, so an early read can return the server's own cwd; on those versions `paneCwd` rejects with `UnsupportedTmuxVersionError` instead of guessing.
- `newEmptyWindow(client, { session })` — needs tmux **3.8+** (`new-window -E`; tmux 3.7 rejects the flag as unknown). It opens a window whose pane has no process, so a caller can set what must hold before one starts and then start it with `respawnPane()` (any supported tmux). With `remain-on-exit failed` set in between, a command that cannot run leaves a dead pane the user sees and `capturePane()` reads; a plain `newWindow()` resolves with ids and tmux closes the window moments later. On older tmux it rejects with `UnsupportedTmuxVersionError` and no window is made.

  ```ts
  const { windowId, paneId } = await newEmptyWindow(client, { session: "work", select: true });
  await client.execute(`set-option -p -t %${paneId} remain-on-exit failed`);
  await respawnPane(client, paneId, { command, environment });
  ```
- The version-gated calls above reject with `UnrecognizedTmuxVersionError` (carrying the raw reply) when the running tmux reports a version that is not a tmux version shape — e.g. OpenBSD base's `openbsd-7.4` — rather than guessing whether the feature is there.
- `watchServerArgs` — its `no-detach-on-destroy` client flag needs tmux **3.6+**. Older tmux silently ignores it, so the watcher exits when its attached session ends instead of moving to another one; `(await getOwnClient(client)).flags` shows whether the flag took effect.

Some notifications are parsed on every tmux but only emitted by a newer one;
on older tmux the listener simply never fires:

- `%paste-buffer-changed` / `%paste-buffer-deleted` — tmux **3.4+**
- `%message` — tmux **3.4+**
- `%config-error` — tmux **3.4+**

No known breaking changes through tmux 3.7 (the version `SPEC.md` is derived
from).

## Watching a whole server

One connection can follow every session on a server as an extra client that
creates, resizes and reconfigures nothing:

```ts
import {
  TmuxClient, spawnTmux, watchServerArgs, getOwnClient,
} from "@promptctl/tmux-control-mode-js";

const client = new TmuxClient(spawnTmux(watchServerArgs("main")), {
  idlePaneSuppression: true, // no pane output unless a sink asks for it
});
const self = await getOwnClient(client);
```

`watchServerArgs()` with no session name attaches to the session a bare
`tmux attach-session` from the same process would land in, for a consumer that
has no name yet, such as one about to call `listSessions`.

- **Attaches, never creates.** `watchServerArgs` attaches to an existing session,
  so the watcher adds no session the user can see. It cannot watch a server that
  has no sessions.
- **Never starts a server.** With none running, tmux exits instead of starting
  one (`-N`), so the user's `tmux.conf`, its hooks and its plugins do not run
  because something tried to watch.
- **Leaves the session's environment alone.** `-E` keeps tmux from copying the
  watcher process's `SSH_AUTH_SOCK`, `DISPLAY` and the rest of
  `update-environment` into the session it attaches to. That covers the attach
  only: a `switch-client` the watcher sends later copies them into the session
  it switches to unless it carries `-E` too.
- **Never resizes.** `ignore-size` keeps the watcher out of window sizing, even if
  it sets a size of its own.
- **Outlives sessions, not the server.** `no-detach-on-destroy` moves the watcher
  to another session when its own one ends (`session-changed`). When the last
  session ends, tmux exits as usual and the watcher gets `exit`.
- **Is still a client.** No flag hides the attach itself, and tmux treats it
  like the user's own. While the watcher is attached to a session, a bare
  `tmux attach` passes over that session for one with no client. The attach
  makes the session the most recently used one, which is where a bare
  `tmux attach` lands once the watcher has gone. Alerts on the session's
  current window clear, and the user's `client-attached` and
  `client-session-changed` hooks run.
- **Knows itself.** tmux counts the watcher like any client (`session_attached`,
  `list-clients`, `%client-detached`). Filter it out by `self.name`. tmux silently
  ignores client flags it doesn't know, so `self.flags` shows which ones took
  effect.
- **Every end is reported.** `exit` fires when the last session ends (or, on
  tmux older than 3.6, when the attached one does), when the server dies, or
  when another client detaches the watcher. tmux sends the same bare
  `%exit` for all of these, so the cause isn't reported.
- **A failed attach says why.** When the watcher never attaches, `exit` carries
  tmux's own text as its `reason` (`no server running on …`,
  `can't find session: main`), and every command already sent rejects with a
  `TransportClosedError` whose `reason` is that same text.

Events in other sessions that tmux does not send to a control client are relayed
separately (`cross-session-layout-change`).

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
At present 24 of the 28 events are observed live on tmux 3.4+; on older tmux,
an event whose `COVERAGE` row carries a `minVersion` above it is skipped. The exemptions each carry
their own reason in the `COVERAGE` table: `%config-error`, whose runtime
provocation is silent on the tmux 3.4 baseline, and the flow-control trio
(`%pause`, `%continue`, `%extended-output`), which fire only under read
backpressure the harness cannot create deterministically.

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
