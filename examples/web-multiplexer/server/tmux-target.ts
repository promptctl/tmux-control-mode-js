// examples/web-multiplexer/server/tmux-target.ts
// Where the demo's control clients attach. By default the host's default tmux
// server; `TMUX_DEMO_SOCKET` pins them to a named `-L` socket (parity with the
// Electron target — keeps e2e / live verification isolated from the user's real
// tmux).
//
// [LAW:single-enforcer] One place computes the attach args. Every control
//   client the bridge spawns — the per-connection client and the mirror
//   registry's dedicated client — reads the target from here, so they can never
//   point at different servers.

/** `tmux -C <these args>` to attach a control client to the demo's target server. */
export function demoAttachArgs(): string[] {
  const socket = process.env.TMUX_DEMO_SOCKET;
  return socket !== undefined && socket.length > 0
    ? ["-L", socket, "attach-session"]
    : ["attach-session"];
}
