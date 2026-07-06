// src/transport/spawn.ts
// Spawn-based transport for tmux control mode.
// Wraps child_process.spawn behind the TmuxTransport interface.

import {
  spawn,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from "node:child_process";
import type { TmuxTransport, SendResult, SpawnOptions } from "./types.js";
import { createCloseGate } from "./close-gate.js";
import { terminateLine } from "./line-termination.js";

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

  // [LAW:single-enforcer] `close` and `error` can both fire for one death
  // (e.g. ENOENT spawn failure emits error then close); the gate's
  // exactly-once dispatch means the first (truest) reason wins — a
  // transport error is never re-reported as a clean exit.
  const closeGate = createCloseGate();

  child.on("close", (code, signal) => {
    closeGate.dispatch(
      signal ?? (code !== null && code !== 0 ? `exit ${code}` : undefined),
    );
  });

  child.on("error", (err) => {
    closeGate.dispatch(err.message);
  });

  // [LAW:no-silent-failure] A Writable that emits `error` with no listener
  // crashes the host process. In the window between tmux dying and the child's
  // `close` event, a write gets EPIPE — this listener absorbs the crash and
  // records the failure so subsequent sends refuse loudly. It does NOT dispatch
  // close: the child's own close event owns the true exit reason.
  // [LAW:single-enforcer] First reason wins, mirroring the close gate: this
  // listener and send()'s synchronous catch both write here, and whichever
  // fires first is the truest cause — a later write's error must not
  // overwrite it.
  let stdinFailure: string | undefined;
  child.stdin.on("error", (err: Error) => {
    stdinFailure ??= err.message;
  });

  const transport: TmuxTransport = {
    // [LAW:single-enforcer] LF-termination logic itself lives in
    // terminateLine(), shared with the websocket transport.
    // Note: sending an empty string writes a bare LF, which detaches the tmux client.
    send(command: string): SendResult {
      const closeState = closeGate.state();
      if (closeState.closed) {
        return {
          ok: false,
          reason:
            closeState.reason === undefined
              ? "transport closed"
              : `transport closed: ${closeState.reason}`,
        };
      }
      if (stdinFailure !== undefined) {
        return { ok: false, reason: `stdin failed: ${stdinFailure}` };
      }
      const terminated = terminateLine(command);
      // [LAW:types-are-the-program] send is total by its own contract; Node
      // stream internals have changed synchronous-throw behavior across
      // majors (e.g. write-after-destroy), so a foreign exception is
      // converted to the typed result at this boundary and recorded like an
      // async stdin failure.
      try {
        child.stdin.write(terminated);
      } catch (err) {
        stdinFailure ??= err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `stdin failed: ${stdinFailure}` };
      }
      return { ok: true };
    },

    onData(callback: (chunk: string) => void): void {
      dataCallbacks.push(callback);
    },

    onClose(callback: (reason?: string) => void): void {
      closeGate.onClose(callback);
    },

    close(): void {
      child.kill();
    },
  };

  return transport;
}

export { spawnTmux };
