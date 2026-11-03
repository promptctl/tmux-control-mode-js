// src/watch-server.ts
// Spawn arguments for a connection that watches a whole tmux server without
// disturbing it — tmux-server-events-6sp.s3u.
//
// [LAW:one-source-of-truth] The watcher's client flags are defined here only.
// Each one answers a way a control client would otherwise change what the
// user sees (all probed on tmux 3.8):
// - ignore-size: the client's size never takes part in window sizing.
// - no-detach-on-destroy: when the attached session ends, the client moves to
//   another session instead of exiting, so one connection outlives any one
//   session. When the last session ends the server exits and the connection
//   ends with it — a control client never keeps a server alive. Needs tmux
//   NO_DETACH_ON_DESTROY_MIN_VERSION (src/tmux-compat.ts); older tmux ignores it.
// Two flags are deliberately absent. `no-output` also blocks `refresh-client
// -A %N:on`, so no sink could ever receive output; a watcher keeps out pane
// output nobody asked for by constructing its TmuxClient with
// `{ idlePaneSuppression: true }`, which pauses per pane. `read-only` makes tmux
// refuse the consumer's own deliberate commands (`send-keys` → "client is
// read-only"); the watcher's presence is what must not disturb, not its use.
//
// Attaching (never `new-session`) is what keeps the watcher from adding a
// session the user can see; it is also why a server with no sessions cannot
// be watched — there is nothing to attach to.
const WATCH_CLIENT_FLAGS = "ignore-size,no-detach-on-destroy";

/**
 * Arguments for `spawnTmux` that attach a watcher to `targetSession`, matched
 * exactly (`=`), never by tmux's prefix or pattern fallback. tmux
 * ignores client flags it does not know; confirm them on the running server
 * with `(await getOwnClient(client)).flags`.
 */
export function watchServerArgs(targetSession: string): string[] {
  return ["attach-session", "-t", `=${targetSession}`, "-f", WATCH_CLIENT_FLAGS];
}
