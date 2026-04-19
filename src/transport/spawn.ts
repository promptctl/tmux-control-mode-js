// src/transport/spawn.ts
// Spawn-based transport for tmux control mode.
// Wraps child_process.spawn behind the TmuxTransport interface.

import {
  spawn,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from "node:child_process";
import type { TmuxTransport, SpawnOptions } from "./types.js";

// [LAW:one-source-of-truth] DCS frame bytes live here only (SPEC §12).
const DCS_INTRODUCER = "\u001bP1000p"; // 7 bytes: ESC P 1 0 0 0 p
const DCS_TERMINATOR = "\u001b\\"; // 2 bytes: ESC backslash

/**
 * Result of feeding a chunk to the DCS stripper.
 *
 * `forward` is the bytes (possibly empty) to hand to downstream consumers.
 * `error`, when present, indicates the stripper has rejected the stream
 * (e.g., the introducer was malformed) and no further forwards will occur.
 */
export interface DcsStripperResult {
  readonly forward: string;
  readonly error?: string;
}

/**
 * Create a stateful DCS introducer stripper for `-CC` mode.
 *
 * The first 7 bytes of the stream MUST be `\u001bP1000p`. Once they have been
 * seen and verified, every subsequent chunk is forwarded byte-for-byte.
 * Handles arbitrary fragmentation (chunk sizes 1..N) of the introducer.
 *
 * [LAW:single-enforcer] DCS strip state lives only inside the closure returned here.
 * [LAW:dataflow-not-control-flow] The same `feed` function runs on every chunk;
 * the `stripped` flag selects between two pure value transformations.
 */
export function createDcsStripper(): (chunk: string) => DcsStripperResult {
  let stripped = false;
  let buffer = "";
  let rejected = false;

  return (chunk: string): DcsStripperResult => {
    if (rejected) return { forward: "" };
    if (stripped) return { forward: chunk };

    buffer += chunk;
    if (buffer.length < DCS_INTRODUCER.length) {
      return { forward: "" };
    }

    if (!buffer.startsWith(DCS_INTRODUCER)) {
      rejected = true;
      return { forward: "", error: "invalid DCS introducer in -CC mode" };
    }

    const remainder = buffer.slice(DCS_INTRODUCER.length);
    buffer = "";
    stripped = true;
    return { forward: remainder };
  };
}

// [LAW:one-source-of-truth] Single function builds the full argv for the tmux process.
function buildArgv(
  controlControl: boolean,
  socketPath: string | undefined,
  userArgs: readonly string[],
): string[] {
  const flag = controlControl ? "-CC" : "-C";
  const socketArgs: readonly string[] =
    socketPath === undefined
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
  const controlControl = options?.controlControl ?? false;

  // [LAW:no-defensive-null-guards] This is a trust-boundary fail-fast, not a
  // silent skip. tmux -CC calls tcgetattr() on stdin and requires PTY-backed
  // stdio (SPEC §12). child_process.spawn provides only pipes, so the resulting
  // tmux process exits immediately with "tcgetattr failed: Inappropriate ioctl
  // for device". Programmatic clients (the typical consumer of this library)
  // gain nothing from -CC vs -C — both carry the identical protocol; -CC
  // exists so terminal emulators can frame the stream within their own escape
  // protocol. If you genuinely need -CC, supply a PTY-backed transport
  // (e.g., one built on node-pty) instead of spawnTmux.
  if (controlControl) {
    throw new Error(
      "spawnTmux: controlControl (-CC) mode requires PTY-backed stdio, " +
        "which child_process.spawn cannot provide. Use -C mode for " +
        "programmatic clients (it carries the identical protocol), or " +
        "supply a custom transport built on node-pty. " +
        "See SPEC.md §12 for details.",
    );
  }

  const argv = buildArgv(controlControl, options?.socketPath, args);

  const dataCallbacks: ((chunk: string) => void)[] = [];
  const closeCallbacks: ((reason?: string) => void)[] = [];

  // [LAW:no-defensive-null-guards] Typing the options triggers the spawn overload
  // that returns ChildProcessByStdio<Writable, Readable, null> — stdin/stdout are
  // non-null by construction, not by runtime assertion.
  const spawnOptions: SpawnOptionsWithStdioTuple<
    StdioPipe,
    StdioPipe,
    StdioNull
  > = {
    stdio: ["pipe", "pipe", "ignore"],
    env: options?.env as NodeJS.ProcessEnv | undefined,
  };
  const child = spawn(tmuxPath, argv, spawnOptions);

  // [LAW:dataflow-not-control-flow] The data pipeline runs on every chunk.
  // In -C mode the stripper is null and the chunk forwards unchanged. In -CC
  // mode the stripper applies the DCS framing rules. The pipeline shape is
  // identical; only the values differ.
  const stripper = controlControl ? createDcsStripper() : null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stripper === null) {
      dataCallbacks.forEach((cb) => cb(chunk));
      return;
    }
    const result = stripper(chunk);
    if (result.error !== undefined) {
      closeCallbacks.forEach((cb) => cb(result.error));
      return;
    }
    if (result.forward.length > 0) {
      dataCallbacks.forEach((cb) => cb(result.forward));
    }
  });

  let closed = false;
  child.on("close", (code, signal) => {
    closed = true;
    const reason =
      signal ?? (code !== null && code !== 0 ? `exit ${code}` : undefined);
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
      child.stdin.write(terminated);
    },

    onData(callback: (chunk: string) => void): void {
      dataCallbacks.push(callback);
    },

    onClose(callback: (reason?: string) => void): void {
      closeCallbacks.push(callback);
    },

    close(): void {
      // [LAW:dataflow-not-control-flow] DCS terminator is conditional on mode (a value),
      // not on whether close runs.
      if (controlControl && !closed && child.stdin.writable) {
        child.stdin.write(DCS_TERMINATOR);
      }
      child.kill();
    },
  };

  return transport;
}

export { spawnTmux };
