// examples/web-multiplexer/web/demo-ipc.ts
// Renderer-side typed accessor for the demo's Electron-only IPC surface.
//
// The Electron preload exposes `window.demoIpc` with a fixed allowlist of
// methods; the WebSocket entry has no equivalent. Any UI that wants to
// call demoIpc must first guard on availability via `getDemoIpc()` —
// nullish on the web target.

export interface DemoIpc {
  /**
   * Names in /tmp/tmux-$UID/, minus the currently-attached socket. `default`
   * is included when present. Trusted directly: pruning runs at app launch
   * (and any other policy-defined moment) so callers never re-probe liveness.
   */
  listSockets(): Promise<readonly string[]>;

  /** The socket the main process currently has its TmuxClient bound to. */
  currentSocket(): Promise<string | null>;

  /**
   * Detach from the current socket and re-attach the demo's TmuxClient
   * to the named one. Resolves once the new bridge is installed. Throws
   * if the name is empty.
   */
  switchSocket(name: string): Promise<void>;
}

declare global {
  interface Window {
    /** Optional — only present in the Electron variant of the demo. */
    readonly demoIpc?: DemoIpc;
  }
}

/** Returns the demo's Electron IPC surface, or null on the web target. */
export function getDemoIpc(): DemoIpc | null {
  return typeof window !== "undefined" && window.demoIpc !== undefined
    ? window.demoIpc
    : null;
}
