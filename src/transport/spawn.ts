// src/transport/spawn.ts
// Spawn-based transport for tmux control mode.
// Wraps child_process.spawn behind the TmuxTransport interface.

import { spawn } from "node:child_process";
import type { TmuxTransport, SpawnOptions } from "./types.js";

// [LAW:one-source-of-truth] Single function builds the full argv for the tmux process.
function buildArgv(controlControl: boolean, socketPath: string | undefined, userArgs: readonly string[]): string[] {
  const flag = controlControl ? "-CC" : "-C";
  const socketArgs: readonly string[] = socketPath === undefined
    ? []
    : socketPath.includes("/")
      ? ["-S", socketPath]
      : ["-L", socketPath];
  return [flag, ...socketArgs, ...userArgs];
}

// [LAW:dataflow-not-control-flow] Callback arrays always exist; they may be empty.
// Every registration pushes; every dispatch iterates. No conditional execution paths.

/**
 * Spawn a tmux child process in control mode and return a TmuxTransport.
 *
 * The child process object is not exposed — consumers interact
 * solely through the TmuxTransport interface.
 */
// [LAW:single-enforcer] LF-termination enforced exactly once, in send().
function spawnTmux(args: string[], options?: SpawnOptions): TmuxTransport {
  const tmuxPath = options?.tmuxPath ?? "tmux";
  const argv = buildArgv(
    options?.controlControl ?? false,
    options?.socketPath,
    args,
  );

  const dataCallbacks: Array<(chunk: string) => void> = [];
  const closeCallbacks: Array<(reason?: string) => void> = [];

  const child = spawn(tmuxPath, argv, {
    stdio: ["pipe", "pipe", "ignore"],
    env: options?.env as NodeJS.ProcessEnv | undefined,
  });

  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    dataCallbacks.forEach((cb) => cb(chunk));
  });

  let closed = false;
  child.on("close", (code, signal) => {
    closed = true;
    const reason = signal ?? (code !== null && code !== 0 ? `exit ${code}` : undefined);
    closeCallbacks.forEach((cb) => cb(reason));
  });

  child.on("error", (err) => {
    closeCallbacks.forEach((cb) => cb(err.message));
  });

  const transport: TmuxTransport = {
    // [LAW:single-enforcer] LF-termination enforced here and nowhere else.
    // Note: sending an empty string writes a bare LF, which detaches the tmux client.
    send(command: string): void {
      if (closed) return;
      const terminated = command.endsWith("\n") ? command : command + "\n";
      child.stdin!.write(terminated);
    },

    onData(callback: (chunk: string) => void): void {
      dataCallbacks.push(callback);
    },

    onClose(callback: (reason?: string) => void): void {
      closeCallbacks.push(callback);
    },

    close(): void {
      child.kill();
    },
  };

  return transport;
}

export { spawnTmux };
