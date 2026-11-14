// src/transport/types.ts
// Transport interface for tmux control mode communication.
// Plain object contract — no EventEmitter, no Node streams.

// [LAW:one-source-of-truth] Single interface defines all transport contracts.

/**
 * The outcome of a {@link TmuxTransport.send}.
 *
 * `ok: true` means the transport ACCEPTED the bytes for transmission — it is
 * not a delivery guarantee; a transport that dies after acceptance reports
 * that through `onLost` or `onClose`. `ok: false` has exactly two causes, and
 * `reason` says which: the transport is not open yet (no lifecycle callback
 * has fired), or it has already announced `onLost` or `onClose`. A refusal is
 * therefore never the first word about a dying connection.
 *
 * [LAW:types-are-the-program] Send failure is a representable outcome, not an
 * exception convention: the compiler forces every implementation to state a
 * result, and forces no caller to guess whether a silent void succeeded.
 * [LAW:dataflow-not-control-flow] Variability lives in the returned value.
 */
export type SendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Minimal transport interface for tmux control mode communication.
 *
 * Any environment (child_process, WebSocket, IPC) can implement this.
 * Intentionally avoids EventEmitter and Node streams for portability.
 */
export interface TmuxTransport {
  /** Send a command string to tmux. Never throws; the result is the outcome. */
  send(command: string): SendResult;

  /** Register callback for incoming data chunks. */
  onData(callback: (chunk: string) => void): void;

  /**
   * Register callback for the connection being gone before its close reason
   * is known: every later send is refused and `onClose` follows. A transport
   * that learns of loss only at close never calls it.
   */
  onLost(callback: (reason: string) => void): void;

  /** Register callback for transport close/error. */
  onClose(callback: (reason?: string) => void): void;

  /**
   * Disconnect from tmux. Idempotent: `client.close()` may call it after the
   * transport already closed, as it always could.
   */
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
}
