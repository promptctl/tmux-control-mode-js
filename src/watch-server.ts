// src/watch-server.ts
// Spawn arguments for a connection that watches a whole tmux server without
// disturbing it — tmux-server-events-6sp.s3u, 6sp.6fc.
//
// [LAW:one-source-of-truth] The watcher's arguments are defined here only.
// Each one answers a way a control client would otherwise change the server
// it connects to (all probed on tmux 3.8):
// - `-N` (tmux's own option): a server that is not running is not started.
//   `attach-session` otherwise starts one, which loads the user's tmux.conf:
//   its hooks and plugins run, and a session it creates is one the watcher
//   caused. With `-N` tmux exits with an error instead.
// - `-E`: tmux's `update-environment` is not applied, so the connecting
//   process's SSH_AUTH_SOCK, DISPLAY, … are not copied into the attached
//   session for every window the user opens there afterwards to inherit.
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
// No argument hides the attach itself: tmux counts the watcher as a client of
// the session and the attach as use of it. README "Watching a whole server"
// lists what follows from that.
//
// Attaching (never `new-session`) is what keeps the watcher from adding a
// session the user can see; it is also why a server with no sessions cannot
// be watched — there is nothing to attach to.
const WATCH_CLIENT_FLAGS = "ignore-size,no-detach-on-destroy";

/**
 * Arguments for `spawnTmux` that attach a watcher. With `targetSession`, to
 * that session, matched exactly (`=`), never by tmux's prefix or pattern
 * fallback. Without one, to the session a bare `tmux attach-session` from the
 * same process would land in — for a consumer that has no session name yet,
 * e.g. to list the sessions. Either way the watcher is a client of that
 * session; README "Watching a whole server" lists what tmux does for one.
 * tmux ignores client flags it does not know; confirm them on the running
 * server with `(await getOwnClient(client)).flags`.
 */
export function watchServerArgs(targetSession?: string): string[] {
  // [LAW:dataflow-not-control-flow] The target is a list of arguments that is
  // empty when tmux is to pick; the same argv is assembled either way.
  const target = targetSession === undefined ? [] : ["-t", `=${targetSession}`];
  return ["-N", "attach-session", "-E", "-f", WATCH_CLIENT_FLAGS, ...target];
}
