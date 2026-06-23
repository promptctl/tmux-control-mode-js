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

// [LAW:decomposition] Argv assembly is one part: control flag and socket (-S/-L)
// selection live at a single cut, so callers pass intent rather than a built argv.
// This transport emits `-C` only. `-CC` requires PTY-backed stdio — tmux calls
// tcgetattr(stdin) at startup (SPEC §12) and child_process.spawn supplies pipes,
// so `-CC` is not representable here; it belongs in a separate PTY-backed
// transport (e.g., one built on node-pty), never a flag this constructor rejects.
function buildArgv(
  socketPath: string | undefined,
  userArgs: readonly string[],
): string[] {
  const socketArgs: readonly string[] =
    socketPath === undefined
      ? []
      : socketPath.includes("/")
        ? ["-S", socketPath]
        : ["-L", socketPath];
  return ["-C", ...socketArgs, ...userArgs];
}

// [LAW:dataflow-not-control-flow] Callback arrays always exist and may be empty;
// every registration pushes and the close/error dispatch iterates the whole array.

/**
 * Spawn a tmux child process in control mode and return a TmuxTransport.
 *
 * The child process object is not exposed — consumers interact
 * solely through the TmuxTransport interface.
 */
// [LAW:single-enforcer] LF-termination enforced exactly once, in send().
function spawnTmux(args: string[], options?: SpawnOptions): TmuxTransport {
  const tmuxPath = options?.tmuxPath ?? "tmux";
  const argv = buildArgv(options?.socketPath, args);

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

  // [LAW:one-source-of-truth] The byte stream is the source of truth. tmux
  // emits pane output bytes 0x80-0xFF (UTF-8, raw) UNescaped; decoding the
  // stream as UTF-8 here would collapse multi-byte sequences into code points
  // the octal decoder then truncates, corrupting all non-ASCII output. Latin-1
  // is a lossless byte↔code-unit mapping: every byte becomes exactly one code
  // unit (0x00-0xFF), the line/space splitting in the parser still works (those
  // delimiters are ASCII), and decodeOctalEscapes recovers the exact bytes.
  // This is a lossless byte container, NOT a semantic decode: the library never
  // re-interprets bytes as UTF-8. Pane output reaches the renderer as raw bytes
  // (the renderer decodes); consumers that need text from a metadata field
  // decode it themselves.
  // [LAW:single-enforcer] exception: setEncoding('latin1') is the Node.js
  // stream API for byte-faithful decode and is equivalent to bytesToLatin1()
  // on a Buffer in Node.js only. This site is exempt because (a) spawn.ts is
  // Node-only and never runs in a browser, and (b) the Buffer.toString('latin1')
  // path that setEncoding triggers is genuinely 1:1 byte↔code-unit in Node
  // (unlike TextDecoder('latin1') which is windows-1252 in browsers). All
  // other transports must use bytesToLatin1() from byte-codec.ts.
  child.stdout.setEncoding("latin1");
  child.stdout.on("data", (chunk: string) => {
    dataCallbacks.forEach((cb) => cb(chunk));
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
      child.kill();
    },
  };

  return transport;
}

export { spawnTmux };
