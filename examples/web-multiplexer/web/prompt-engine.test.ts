// examples/web-multiplexer/web/prompt-engine.test.ts
//
// Unit tests for the pure OSC 133 prompt/command engine. The engine is a pure
// function of (byte chunks) → (command history), so every behaviour is pinned
// here in isolation — no firehose, no MobX, no DOM. [LAW:behavior-not-structure]
// the assertions are over the framed commands + their status (the contract),
// never over the private per-pane phase/carry-over (the mechanism).

import { describe, it, expect } from "vitest";
import {
  PromptEngine,
  parseOsc133,
  type CommandRecord,
} from "./prompt-engine.ts";

const PANE = 7;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** ESC `]` … ST — build an OSC string with the ESC `\` terminator. */
const osc = (body: string): string => `\x1b]${body}\x1b\\`;
/** OSC 133 marks. */
const A = osc("133;A"); // prompt start
const B = osc("133;B"); // command start
const C = osc("133;C"); // output start (command executed)
const D = (code?: number): string => osc(code === undefined ? "133;D" : `133;D;${code}`);

/** A complete command lifecycle: prompt, the typed line, output, finish. */
const cmd = (line: string, output = "", code?: number): string =>
  `${A}[32m$[0m ${B}${line}\n${C}${output}${D(code)}`;

/** Feed chunks into a fresh engine and return its command history. */
function collect(...chunks: string[]): readonly CommandRecord[] {
  const engine = new PromptEngine(1000);
  for (const c of chunks) engine.pushBytes(PANE, enc(c));
  return engine.commands;
}

describe("parseOsc133", () => {
  const b = (s: string): number[] => [...enc(s)];

  it("parses each point mark A/B/C", () => {
    expect(parseOsc133(b("133;A"))?.mark).toBe("A");
    expect(parseOsc133(b("133;B"))?.mark).toBe("B");
    expect(parseOsc133(b("133;C"))?.mark).toBe("C");
  });

  it("parses D with no exit code as exitCode null", () => {
    expect(parseOsc133(b("133;D"))).toEqual({ mark: "D", exitCode: null });
  });

  it("parses D with a numeric exit code", () => {
    expect(parseOsc133(b("133;D;0"))).toEqual({ mark: "D", exitCode: 0 });
    expect(parseOsc133(b("133;D;130"))).toEqual({ mark: "D", exitCode: 130 });
  });

  it("tolerates aux params after the mark letter", () => {
    expect(parseOsc133(b("133;A;aid=12"))?.mark).toBe("A");
    expect(parseOsc133(b("133;D;1;extra"))).toEqual({ mark: "D", exitCode: 1 });
  });

  it("returns null for a non-numeric D exit code", () => {
    expect(parseOsc133(b("133;D;abc"))).toEqual({ mark: "D", exitCode: null });
  });

  it("returns null for a non-133 OSC (a window title)", () => {
    expect(parseOsc133(b("0;my title"))).toBeNull();
  });

  it("returns null for OSC 8 (a hyperlink)", () => {
    expect(parseOsc133(b("8;;https://example.com"))).toBeNull();
  });

  it("returns null for an unknown 133 sub-mark", () => {
    expect(parseOsc133(b("133;Z"))).toBeNull();
    expect(parseOsc133(b("133"))).toBeNull();
  });
});

describe("PromptEngine — chunking one command", () => {
  it("extracts the command line, output and exit code", () => {
    const cmds = collect(cmd("ls -la", "total 0\nfile.txt\n", 0));
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({
      command: "ls -la",
      paneId: PANE,
      status: { kind: "finished", exitCode: 0 },
    });
    expect(cmds[0].output).toContain("file.txt");
  });

  it("captures a non-zero exit code", () => {
    const cmds = collect(cmd("false", "", 1));
    expect(cmds[0].status).toEqual({ kind: "finished", exitCode: 1 });
  });

  it("treats D with no exit code as finished/unknown", () => {
    const cmds = collect(`${A}${B}whoami\n${C}me${D()}`);
    expect(cmds[0].status).toEqual({ kind: "finished", exitCode: null });
  });

  it("strips the prompt string — only the B→C span is the command", () => {
    // The `$ ` and its SGR coloring are BEFORE B; they must not leak in.
    const cmds = collect(cmd("echo hi", "hi\n", 0));
    expect(cmds[0].command).toBe("echo hi");
  });

  it("accepts BEL-terminated marks (not just ESC backslash)", () => {
    const bel = `\x1b]133;A\x07\x1b]133;B\x07pwd\n\x1b]133;C\x07/home\x1b]133;D;0\x07`;
    expect(collect(bel)[0]).toMatchObject({
      command: "pwd",
      status: { kind: "finished", exitCode: 0 },
    });
  });
});

describe("PromptEngine — clean command lines", () => {
  it("strips SGR coloring embedded in the typed command (syntax highlight)", () => {
    const colored = `${A}${B}\x1b[33mgit\x1b[0m status\n${C}${D(0)}`;
    expect(collect(colored)[0].command).toBe("git status");
  });

  it("trims the surrounding whitespace + Enter-newline but preserves internal spacing", () => {
    // Fidelity: this string is destined for `sendKeys` (re-run), so internal
    // spaces are NOT collapsed — only the prompt indent and the trailing Enter go.
    const cmds = collect(`${A}${B}   make   build   \n${C}${D(0)}`);
    expect(cmds[0].command).toBe("make   build");
  });
});

describe("PromptEngine — running vs finished", () => {
  it("reports a command as running between C and D", () => {
    const cmds = collect(`${A}${B}sleep 99\n${C}`);
    expect(cmds[0]).toMatchObject({
      command: "sleep 99",
      status: { kind: "running" },
    });
  });

  it("accumulates output preview while still running", () => {
    const engine = new PromptEngine(1000);
    engine.pushBytes(PANE, enc(`${A}${B}tail -f log\n${C}line 1\n`));
    expect(engine.commands[0].status).toEqual({ kind: "running" });
    expect(engine.commands[0].output).toContain("line 1");
    engine.pushBytes(PANE, enc(`line 2\n${D(0)}`));
    expect(engine.commands[0].status).toEqual({ kind: "finished", exitCode: 0 });
    expect(engine.commands[0].output).toContain("line 2");
  });

  it("finalizes a dangling running command when the NEXT prompt (A) arrives", () => {
    // D was dropped; the next prompt proves the prior command finished.
    const cmds = collect(`${A}${B}first\n${C}out${A}${B}second\n${C}${D(0)}`);
    expect(cmds.map((c) => c.command)).toEqual(["first", "second"]);
    expect(cmds[0].status).toEqual({ kind: "finished", exitCode: null });
    expect(cmds[1].status).toEqual({ kind: "finished", exitCode: 0 });
  });
});

describe("PromptEngine — empty + malformed", () => {
  it("does NOT record an empty command (Enter at an empty prompt)", () => {
    expect(collect(`${A}${B}${C}${D(0)}`)).toHaveLength(0);
  });

  it("records nothing when C arrives without a preceding B", () => {
    // No command-start mark → no B→C span → no command.
    expect(collect(`${A}${C}some output${D(0)}`)).toHaveLength(0);
  });

  it("ignores a D with no running command", () => {
    expect(collect(`${A}${D(0)}`)).toHaveLength(0);
  });

  it("ignores non-133 OSC sequences entirely (titles, hyperlinks)", () => {
    const noise = `${osc("0;a title")}${osc("8;;https://x")}plain text`;
    expect(collect(noise)).toHaveLength(0);
  });

  it("does NOT heuristically detect a `$ ` prompt in plain text (OSC 133 only)", () => {
    expect(collect("$ ls\nfile.txt\n$ pwd\n/home\n")).toHaveLength(0);
  });
});

describe("PromptEngine — streaming across chunk boundaries", () => {
  it("frames a command split inside the command line", () => {
    const whole = cmd("echo split-me", "ok\n", 0);
    const at = whole.indexOf("split");
    expect(collect(whole.slice(0, at), whole.slice(at))[0]).toMatchObject({
      command: "echo split-me",
    });
  });

  it("frames a mark split between the ESC and the backslash of ST", () => {
    const whole = cmd("uptime", "up\n", 0);
    // Cut right before a final ST backslash so ST spans two chunks.
    const at = whole.lastIndexOf("\\");
    const cmds = collect(whole.slice(0, at), whole.slice(at));
    expect(cmds[0]).toMatchObject({
      command: "uptime",
      status: { kind: "finished", exitCode: 0 },
    });
  });

  it("frames a D mark whose exit code is split across chunks", () => {
    const whole = `${A}${B}grep x\n${C}\x1b]133;D;12`;
    const engine = new PromptEngine(1000);
    engine.pushBytes(PANE, enc(whole)); // D not yet terminated
    expect(engine.commands[0].status).toEqual({ kind: "running" });
    engine.pushBytes(PANE, enc("3\x1b\\")); // …completes "123"
    expect(engine.commands[0].status).toEqual({ kind: "finished", exitCode: 123 });
  });
});

describe("PromptEngine — multi-pane history", () => {
  it("chunks commands per pane and labels each with its origin", () => {
    const engine = new PromptEngine(1000);
    engine.pushBytes(1, enc(cmd("ls", "a\n", 0)));
    engine.pushBytes(2, enc(cmd("pwd", "/root\n", 0)));
    const cmds = engine.commands;
    expect(cmds.map((c) => [c.paneId, c.command])).toEqual([
      [1, "ls"],
      [2, "pwd"],
    ]);
  });

  it("interleaves two panes' command streams without crossing state", () => {
    const engine = new PromptEngine(1000);
    // Pane 1 opens a command; pane 2 runs a whole one in between; pane 1 finishes.
    engine.pushBytes(1, enc(`${A}${B}long-cmd\n${C}partial`));
    engine.pushBytes(2, enc(cmd("quick", "done\n", 0)));
    engine.pushBytes(1, enc(`more${D(7)}`));
    const byPane = new Map(engine.commands.map((c) => [c.paneId, c]));
    expect(byPane.get(1)).toMatchObject({
      command: "long-cmd",
      status: { kind: "finished", exitCode: 7 },
    });
    expect(byPane.get(2)).toMatchObject({
      command: "quick",
      status: { kind: "finished", exitCode: 0 },
    });
  });

  it("orders history by start across panes", () => {
    const engine = new PromptEngine(1000);
    engine.pushBytes(3, enc(cmd("first", "", 0)));
    engine.pushBytes(9, enc(cmd("second", "", 0)));
    expect(engine.commands.map((c) => c.command)).toEqual(["first", "second"]);
  });
});

describe("PromptEngine — capacity, counts, clear", () => {
  it("evicts the oldest commands past capacity", () => {
    const engine = new PromptEngine(2);
    engine.pushBytes(PANE, enc(cmd("one", "", 0)));
    engine.pushBytes(PANE, enc(cmd("two", "", 0)));
    engine.pushBytes(PANE, enc(cmd("three", "", 0))); // evicts "one"
    expect(engine.commands.map((c) => c.command)).toEqual(["two", "three"]);
    expect(engine.commandCount).toBe(2);
  });

  it("reports the number of distinct panes tapped", () => {
    const engine = new PromptEngine(1000);
    engine.pushBytes(1, enc(cmd("a", "", 0)));
    engine.pushBytes(2, enc("plain output, no marks"));
    expect(engine.tappedPaneCount).toBe(2);
  });

  it("clear() drops history and per-pane carry-over", () => {
    const engine = new PromptEngine(1000);
    engine.pushBytes(PANE, enc(cmd("a", "", 0)));
    engine.clear();
    expect(engine.commands).toHaveLength(0);
    expect(engine.commandCount).toBe(0);
    expect(engine.tappedPaneCount).toBe(0);
  });

  it("assigns stable distinct ids to each command", () => {
    const cmds = collect(cmd("a", "", 0), cmd("b", "", 0), cmd("c", "", 0));
    const ids = cmds.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });
});
