// src/transport/types.ts
// Transport interface for tmux control mode communication.
// Plain object contract — no EventEmitter, no Node streams.

// [LAW:one-source-of-truth] Single interface defines all transport contracts.

/**
 * Minimal transport interface for tmux control mode communication.
 *
 * Any environment (child_process, WebSocket, IPC) can implement this.
 * Intentionally avoids EventEmitter and Node streams for portability.
 */
export interface TmuxTransport {
  /** Send a command string to tmux. */
  send(command: string): void;

  /** Register callback for incoming data chunks. */
  onData(callback: (chunk: string) => void): void;

  /** Register callback for transport close/error. */
  onClose(callback: (reason?: string) => void): void;

  /**
   * Optional. Register a callback fired when the underlying wire has been
   * re-established AFTER a previous drop — i.e. tmux now sees a fresh
   * connection with no subscriptions or in-flight commands attached. Tells
   * `TmuxClient` to re-issue every live subscription against the new tmux
   * server (the old one is gone or has forgotten this client) before any
   * new caller traffic flows.
   *
   * Transports that never reconnect (e.g. spawned child processes) MUST NOT
   * implement this method — `TmuxClient` reads `transport.onReconnect?.(...)`
   * and treats absence as "this transport is single-shot." Implementing as a
   * no-op would silently disable subscription recovery for any transport
   * that should support it but stubbed wrong.
   *
   * Each call registers an additional handler. Handlers are invoked AFTER
   * the new wire is open and ready to accept commands; the transport must
   * not fire onReconnect before the handshake (if any) completes.
   */
  onReconnect?(callback: () => void): void;

  /** Disconnect from tmux. */
  close(): void;
}

/**
 * Options for spawning a tmux child process.
 */
export interface SpawnOptions {
  /** Path to the tmux binary. */
  readonly tmuxPath?: string;

  /** Socket path — passed as `-L` (name) or `-S` (path) to tmux. */
  readonly socketPath?: string;

  /** Environment variables for the child process. */
  readonly env?: Record<string, string | undefined>;

  /** Use `-CC` mode instead of `-C`. */
  readonly controlControl?: boolean;
}
