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
