// examples/web-multiplexer/web/broadcast-engine.test.ts
//
// Pure-engine tests for "smart broadcast input with per-pane transforms". No
// tmux, no DOM — a template + synthetic per-pane bindings in, per-pane bytes (or
// a structured miss) out. The load-bearing invariants:
//   - THE TRANSFORM IS A VALUE: one template resolves to a DIFFERENT payload per
//     pane purely from its bindings; the resolver is blind to whether a binding is
//     a pane fact or a user override.
//   - AN UNBOUND VARIABLE IS A LOUD MISS, never "": a referenced var with no
//     binding key makes the pane `unresolved` and names every missing var; a
//     binding present-but-empty is a deliberate empty substitution, not a miss.
//   - PREVIEW === WIRE: `appendEnter` puts the `\r` into the resolved text, so the
//     bytes the view shows are the bytes that go out.
//   - THE TEMPLATE LANGUAGE is its own (shell-flavored) tokenizer: `${name}`,
//     `$name`, `$$` → literal `$`, malformed `$` degrades to literal.

import { describe, it, expect } from "vitest";
import {
  BUILTIN_VARS,
  type PaneBindings,
  type PaneFacts,
  builtinBindings,
  parseTemplate,
  resolveBroadcast,
  sendablePanes,
  templateVars,
} from "./broadcast-engine.ts";

// --- builders --------------------------------------------------------------

function target(paneId: number, bindings: Record<string, string>): PaneBindings {
  return { paneId, bindings };
}

const FACTS: PaneFacts = {
  paneId: 7,
  paneIndex: 2,
  title: "vim",
  width: 80,
  height: 24,
  windowName: "edit",
  windowIndex: 1,
  sessionName: "work",
};

// --- parseTemplate ---------------------------------------------------------

describe("parseTemplate", () => {
  it("splits literals and ${name} references, coalescing adjacent literals", () => {
    expect(parseTemplate("ssh ${host} now")).toEqual([
      { kind: "literal", text: "ssh " },
      { kind: "var", name: "host" },
      { kind: "literal", text: " now" },
    ]);
  });

  it("parses the bare $name form up to the first non-name char", () => {
    expect(parseTemplate("echo $pane.")).toEqual([
      { kind: "literal", text: "echo " },
      { kind: "var", name: "pane" },
      { kind: "literal", text: "." },
    ]);
  });

  it("allows ${name} to abut following text", () => {
    expect(parseTemplate("${host}.local")).toEqual([
      { kind: "var", name: "host" },
      { kind: "literal", text: ".local" },
    ]);
  });

  it("treats $$ as a literal dollar", () => {
    expect(parseTemplate("cost is $$5")).toEqual([
      { kind: "literal", text: "cost is $5" },
    ]);
  });

  it("degrades a malformed $ to a literal dollar", () => {
    expect(parseTemplate("price $ end")).toEqual([
      { kind: "literal", text: "price $ end" },
    ]);
    expect(parseTemplate("trailing $")).toEqual([
      { kind: "literal", text: "trailing $" },
    ]);
    expect(parseTemplate("unterminated ${oops")).toEqual([
      { kind: "literal", text: "unterminated ${oops" },
    ]);
    expect(parseTemplate("${}")).toEqual([{ kind: "literal", text: "${}" }]);
  });

  it("is total over the empty string", () => {
    expect(parseTemplate("")).toEqual([]);
  });
});

// --- templateVars ----------------------------------------------------------

describe("templateVars", () => {
  it("returns distinct names in first-appearance order", () => {
    expect(templateVars("${a} ${b} $a ${c} $b")).toEqual(["a", "b", "c"]);
  });

  it("is empty for a template with no variables", () => {
    expect(templateVars("plain text $$")).toEqual([]);
  });
});

// --- builtinBindings -------------------------------------------------------

describe("builtinBindings", () => {
  it("projects every PaneFacts field, with pane as the bare numeric id", () => {
    expect(builtinBindings(FACTS)).toEqual({
      pane: "7",
      index: "2",
      title: "vim",
      width: "80",
      height: "24",
      window: "edit",
      windowindex: "1",
      session: "work",
    });
  });

  it("binds exactly the advertised BUILTIN_VARS — no more, no less", () => {
    expect(Object.keys(builtinBindings(FACTS)).sort()).toEqual(
      [...BUILTIN_VARS].sort(),
    );
  });
});

// --- resolveBroadcast: the transform is a value ----------------------------

describe("resolveBroadcast", () => {
  it("resolves one template to a DIFFERENT payload per pane from its bindings", () => {
    const out = resolveBroadcast(
      "ssh ${host}",
      [
        target(1, { host: "web-1" }),
        target(2, { host: "web-2" }),
        target(3, { host: "db-1" }),
      ],
      { appendEnter: false },
    );
    expect(out).toEqual([
      { kind: "resolved", paneId: 1, text: "ssh web-1" },
      { kind: "resolved", paneId: 2, text: "ssh web-2" },
      { kind: "resolved", paneId: 3, text: "ssh db-1" },
    ]);
  });

  it("is blind to the binding source — pane facts and overrides resolve alike", () => {
    // `pane` is a built-in fact; `tag` is a user override. Both are just keys.
    const out = resolveBroadcast(
      "echo ${pane}:${tag}",
      [target(7, { ...builtinBindings(FACTS), tag: "canary" })],
      { appendEnter: false },
    );
    expect(out).toEqual([{ kind: "resolved", paneId: 7, text: "echo 7:canary" }]);
  });

  it("marks a pane unresolved and names every missing variable — never ''", () => {
    const out = resolveBroadcast(
      "ssh ${host} as ${user}",
      [target(1, { host: "web-1" }), target(2, { host: "web-2", user: "root" })],
      { appendEnter: false },
    );
    expect(out[0]).toEqual({ kind: "unresolved", paneId: 1, missing: ["user"] });
    expect(out[1]).toEqual({
      kind: "resolved",
      paneId: 2,
      text: "ssh web-2 as root",
    });
  });

  it("collects multiple missing vars de-duplicated in first-appearance order", () => {
    const out = resolveBroadcast(
      "${a} ${b} ${a} ${c}",
      [target(1, {})],
      { appendEnter: false },
    );
    expect(out[0]).toEqual({ kind: "unresolved", paneId: 1, missing: ["a", "b", "c"] });
  });

  it("treats a present-but-empty binding as a deliberate substitution, not a miss", () => {
    const out = resolveBroadcast(
      "git commit${flag}",
      [target(1, { flag: "" })],
      { appendEnter: false },
    );
    expect(out[0]).toEqual({ kind: "resolved", paneId: 1, text: "git commit" });
  });

  it("appends a CR to resolved payloads when appendEnter is on (preview === wire)", () => {
    const out = resolveBroadcast("ls", [target(1, {})], { appendEnter: true });
    expect(out[0]).toEqual({ kind: "resolved", paneId: 1, text: "ls\r" });
  });

  it("does NOT append a CR to an unresolved pane", () => {
    const out = resolveBroadcast("ssh ${host}", [target(1, {})], {
      appendEnter: true,
    });
    expect(out[0]).toEqual({ kind: "unresolved", paneId: 1, missing: ["host"] });
  });

  it("resolves an empty target list to an empty result", () => {
    expect(resolveBroadcast("ls", [], { appendEnter: true })).toEqual([]);
  });
});

// --- sendablePanes ---------------------------------------------------------

describe("sendablePanes", () => {
  it("keeps only resolved panes, carrying their paneId + text", () => {
    const resolutions = resolveBroadcast(
      "ssh ${host}",
      [target(1, { host: "a" }), target(2, {}), target(3, { host: "c" })],
      { appendEnter: true },
    );
    expect(sendablePanes(resolutions)).toEqual([
      { paneId: 1, text: "ssh a\r" },
      { paneId: 3, text: "ssh c\r" },
    ]);
  });

  it("is empty when every pane is unresolved", () => {
    const resolutions = resolveBroadcast("${x}", [target(1, {}), target(2, {})], {
      appendEnter: false,
    });
    expect(sendablePanes(resolutions)).toEqual([]);
  });
});
