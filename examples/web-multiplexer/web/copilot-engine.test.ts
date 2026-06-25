// examples/web-multiplexer/web/copilot-engine.test.ts
//
// Pure-engine coverage for the AI co-pilot (tmux-showcase-bhx.22): prompt
// construction from command history, and the tolerant parse of a reasoning
// model's reply. [LAW:behavior-not-structure] asserts the CONTRACT — what
// messages carry, which suggestions survive — never the private parse helpers.

import { describe, it, expect } from "vitest";
import {
  buildCopilotMessages,
  parseSuggestions,
  type CommandSuggestion,
} from "./copilot-engine.ts";
import type { CommandRecord } from "./prompt-engine.ts";

let nextId = 1;
function cmd(
  command: string,
  opts: {
    paneId?: number;
    output?: string;
    status?: CommandRecord["status"];
  } = {},
): CommandRecord {
  const id = nextId++;
  return {
    id,
    seq: id,
    paneId: opts.paneId ?? 1,
    command,
    output: opts.output ?? "",
    status: opts.status ?? { kind: "finished", exitCode: 0 },
  };
}

describe("buildCopilotMessages", () => {
  it("emits a system + user message", () => {
    const msgs = buildCopilotMessages([cmd("ls")], { paneLabel: "dev:0.1" });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
  });

  it("includes the pane label and the command lines in the user message", () => {
    const msgs = buildCopilotMessages([cmd("git status"), cmd("git log")], {
      paneLabel: "dev:0.1",
    });
    expect(msgs[1].content).toContain("dev:0.1");
    expect(msgs[1].content).toContain("git status");
    expect(msgs[1].content).toContain("git log");
  });

  it("renders the outcome and an output preview", () => {
    const msgs = buildCopilotMessages(
      [cmd("make", { output: "Error: missing target", status: { kind: "finished", exitCode: 2 } })],
      { paneLabel: "p" },
    );
    expect(msgs[1].content).toContain("exit 2");
    expect(msgs[1].content).toContain("Error: missing target");
  });

  it("renders a running command without an exit code", () => {
    const msgs = buildCopilotMessages([cmd("sleep 60", { status: { kind: "running" } })], {
      paneLabel: "p",
    });
    expect(msgs[1].content).toContain("running");
    expect(msgs[1].content).not.toContain("exit");
  });

  it("keeps only the most recent `max` commands", () => {
    const history = Array.from({ length: 20 }, (_, i) => cmd(`cmd-${i}`));
    const msgs = buildCopilotMessages(history, { paneLabel: "p", max: 3 });
    expect(msgs[1].content).toContain("cmd-19");
    expect(msgs[1].content).toContain("cmd-17");
    expect(msgs[1].content).not.toContain("cmd-16");
  });

  it("bounds a huge output preview rather than dumping it whole", () => {
    const huge = "x".repeat(5000);
    const msgs = buildCopilotMessages([cmd("cat big", { output: huge })], { paneLabel: "p" });
    expect(msgs[1].content.length).toBeLessThan(2000);
    expect(msgs[1].content).toContain("more chars");
  });

  it("handles empty history honestly", () => {
    const msgs = buildCopilotMessages([], { paneLabel: "p" });
    expect(msgs[1].content).toContain("no commands");
  });
});

describe("parseSuggestions", () => {
  const commandsOf = (s: CommandSuggestion[]): string[] => s.map((x) => x.command);

  it("parses a clean JSON array", () => {
    const out = parseSuggestions(
      '[{"command": "git add .", "reason": "stage changes"}, {"command": "git commit", "reason": "commit"}]',
    );
    expect(commandsOf(out)).toEqual(["git add .", "git commit"]);
    expect(out[0].reason).toBe("stage changes");
  });

  it("strips a <think> reasoning block before the array", () => {
    const raw =
      "<think>\nThe tree is clean, so they probably want to commit.\n</think>\n\n" +
      '[{"command": "git commit -m msg", "reason": "commit clean tree"}]';
    expect(commandsOf(parseSuggestions(raw))).toEqual(["git commit -m msg"]);
  });

  it("extracts the array out of markdown code fences", () => {
    const raw = '```json\n[{"command": "ls -la", "reason": "list"}]\n```';
    expect(commandsOf(parseSuggestions(raw))).toEqual(["ls -la"]);
  });

  it("extracts the array out of surrounding prose", () => {
    const raw =
      'Here are some suggestions:\n[{"command": "npm test", "reason": "run tests"}]\nHope that helps!';
    expect(commandsOf(parseSuggestions(raw))).toEqual(["npm test"]);
  });

  it("finds the array even when nested in a wrapper object", () => {
    const raw = '{"suggestions": [{"command": "pwd", "reason": "where am i"}]}';
    expect(commandsOf(parseSuggestions(raw))).toEqual(["pwd"]);
  });

  it("respects brackets inside reason strings", () => {
    const raw = '[{"command": "echo hi", "reason": "prints [hi] to stdout"}]';
    const out = parseSuggestions(raw);
    expect(commandsOf(out)).toEqual(["echo hi"]);
    expect(out[0].reason).toBe("prints [hi] to stdout");
  });

  it("defaults a missing reason to empty string", () => {
    const out = parseSuggestions('[{"command": "make"}]');
    expect(out).toEqual([{ command: "make", reason: "" }]);
  });

  it("drops entries with no usable command", () => {
    const raw =
      '[{"reason": "no command here"}, {"command": "", "reason": "empty"}, {"command": "valid"}, {"command": 42}]';
    expect(commandsOf(parseSuggestions(raw))).toEqual(["valid"]);
  });

  it("dedupes repeated commands, keeping the first", () => {
    const raw =
      '[{"command": "ls", "reason": "first"}, {"command": "ls", "reason": "dup"}]';
    const out = parseSuggestions(raw);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("first");
  });

  it("returns [] for a reply with no array (no fabrication)", () => {
    expect(parseSuggestions("I cannot help with that.")).toEqual([]);
    expect(parseSuggestions("<think>still thinking, never finished")).toEqual([]);
    expect(parseSuggestions("")).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseSuggestions('[{"command": "ls", ')).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(parseSuggestions("[]")).toEqual([]);
  });
});
