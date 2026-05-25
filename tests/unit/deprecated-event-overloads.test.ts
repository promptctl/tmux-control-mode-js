// tests/unit/deprecated-event-overloads.test.ts
// Behavior-level test for the public type surface — every TmuxClient-shaped
// class advertises `@deprecated` on its `'output'` and `'extended-output'`
// event overloads, pointing consumers at `attachPaneSink` (the canonical
// pane-byte surface; see src/pane-sink.ts and IMPL.md §5).
//
// [LAW:behavior-not-structure] The assertion is *what the surface advertises*
// — that an IDE displays a strikethrough on these overloads — not *how* the
// deprecation is implemented. We scan the source `.ts` files: TypeScript's
// declaration emit preserves `@deprecated` JSDoc verbatim into `.d.ts`, so an
// assertion on the source is equivalent to an assertion on the emitted
// declarations for this property. Scanning source keeps the test self-
// contained (no `pnpm run build` precondition) and matches the repo's
// existing law-marker auditing pattern (`grep -n "[LAW:" src/`).
//
// [LAW:single-enforcer] One test owns this assertion across every
// TmuxClient-shaped class. A new bridge class with an `on` overload that
// forgets `@deprecated` on `'output'` shows up here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

// Each entry names a public TmuxClient-shaped class and the source file
// where its `on`/`off` overloads live. Adding a new bridge class requires
// one entry here so the deprecation surface is enforced uniformly.
const SURFACES: ReadonlyArray<{ name: string; srcFile: string }> = [
  {
    name: "TmuxClient",
    srcFile: resolve(repoRoot, "src/client.ts"),
  },
  {
    name: "WebSocketTmuxClient",
    srcFile: resolve(repoRoot, "src/connectors/websocket/client.ts"),
  },
  {
    name: "TmuxClientProxy",
    srcFile: resolve(repoRoot, "src/connectors/electron/renderer.ts"),
  },
  {
    name: "FakeTmuxClient",
    srcFile: resolve(
      repoRoot,
      "packages/pane-terminal/src/bench/fake-tmux-client.ts",
    ),
  },
];

/**
 * For each `on(...)` or `off(...)` overload whose first parameter is the
 * literal `"output"` (or `"extended-output"`), find the doc-block that is
 * *directly adjacent* to the overload and assert it contains `@deprecated`
 * and names `attachPaneSink`. The parameter identifier is left open (`\w+`)
 * so harmless renames (`event` → `eventName`, `type` → `name`) don't break
 * the assertion — that would be a structural check, not a behavior check.
 *
 * Anchoring on `on(` / `off(` (not just any colon-quoted literal) is what
 * keeps the regex honest: object literals like `dispatch({ type: "output",
 * ... })` inside method bodies must NOT match. Source files contain both the
 * overload signatures and the implementation signatures for `on`/`off`; the
 * implementation signatures are typed `event: string`, so the literal-event
 * pattern naturally selects only the overload rows we care about.
 *
 * Adjacency check: a doc-block "belongs" to an overload only if its closing
 * marker appears immediately before the signature with nothing but
 * whitespace between them. Without this constraint, `lastIndexOf("/**", …)`
 * could walk past a missing-JSDoc overload and grab an earlier overload's
 * deprecation block — a false positive. The adjacency invariant kills that
 * leak: if the overload lacks its own JSDoc, the nearest closing marker
 * belongs to something else and the gap fails the whitespace-only check.
 */
function expectAllOverloadsDeprecated(
  source: string,
  surfaceName: string,
  eventName: "output" | "extended-output",
): void {
  // `\s*` (which already matches `\n`) handles the multi-line signature form
  // `on(\n  event: "output",\n  handler: ...\n)` produced by the formatter.
  const sigPattern = new RegExp(
    `\\b(?:on|off)\\s*\\(\\s*\\w+\\s*:\\s*"${eventName}"`,
    "g",
  );
  const matches = [...source.matchAll(sigPattern)];
  expect(
    matches.length,
    `${surfaceName}: expected at least two on/off('${eventName}', ...) overloads (one for on, one for off)`,
  ).toBeGreaterThanOrEqual(2);

  for (const m of matches) {
    const sigStart = m.index!;

    // Find the nearest doc-block closing marker before this overload.
    const docEndMarker = source.lastIndexOf("*/", sigStart);
    expect(
      docEndMarker,
      `${surfaceName}: no doc-block precedes the '"${eventName}"' overload at offset ${sigStart}`,
    ).toBeGreaterThan(-1);

    // Adjacency: everything between the doc-block's closing `*/` and the
    // overload signature must be whitespace only. If there's any other
    // token (another overload signature, a method body, a `private` member,
    // etc.) then that JSDoc belongs to whatever sits in the gap, not to
    // our overload — fail rather than walk further back.
    const gap = source.slice(docEndMarker + 2, sigStart);
    expect(
      gap.trim(),
      `${surfaceName}: the '"${eventName}"' overload at offset ${sigStart} is not immediately preceded by a doc-block (gap contained non-whitespace: ${JSON.stringify(gap.slice(0, 80))}…). Each overload must carry its own JSDoc.`,
    ).toBe("");

    // Walk back from the closing marker to the matching opener. With the
    // adjacency check passing, this opener is unambiguous: the doc-block
    // ending at `docEndMarker` is the one attached to the overload.
    const docStart = source.lastIndexOf("/**", docEndMarker);
    expect(
      docStart,
      `${surfaceName}: malformed doc-block before the '"${eventName}"' overload at offset ${sigStart} (closing marker has no opener)`,
    ).toBeGreaterThan(-1);

    const docBlock = source.slice(docStart, docEndMarker + 2);
    expect(
      docBlock.includes("@deprecated"),
      `${surfaceName}: doc-block on the '"${eventName}"' overload at offset ${sigStart} is missing @deprecated. Found:\n${docBlock}`,
    ).toBe(true);
    expect(
      docBlock.includes("attachPaneSink"),
      `${surfaceName}: doc-block on the '"${eventName}"' overload at offset ${sigStart} should name attachPaneSink as the replacement. Found:\n${docBlock}`,
    ).toBe(true);
  }
}

describe("deprecated event overloads on TmuxClient-shaped classes", () => {
  for (const { name, srcFile } of SURFACES) {
    it(`${name} advertises @deprecated on its 'output'/'extended-output' overloads`, () => {
      const source = readFileSync(srcFile, "utf8");
      expectAllOverloadsDeprecated(source, name, "output");
      expectAllOverloadsDeprecated(source, name, "extended-output");
    });
  }
});
