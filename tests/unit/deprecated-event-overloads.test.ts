// tests/unit/deprecated-event-overloads.test.ts
// Behavior-level test for the public type surface — every TmuxClient-shaped
// class advertises `@deprecated` on its `'output'` and `'extended-output'`
// event overloads, pointing consumers at `attachPaneSink` (the canonical
// pane-byte surface; see src/pane-sink.ts and IMPL.md §5).
//
// [LAW:behavior-not-structure] The assertion is *what the surface advertises*
// — that an IDE rendering the `.d.ts` displays a strikethrough on these
// overloads — not *how* the deprecation is implemented. The test reads the
// emitted declaration files because TypeScript's @deprecated suggestion lives
// in JSDoc, which only survives into the `.d.ts` (the `.ts` source is not
// what external consumers consume — `dist/` is).
//
// [LAW:single-enforcer] One test owns this assertion across every
// TmuxClient-shaped class. If a future bridge class adds an `on` overload
// that forgets `@deprecated` on `'output'`, it shows up here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

// Each entry names a public TmuxClient-shaped class and the emitted `.d.ts`
// where its `on`/`off` overloads live. Adding a new bridge class requires one
// entry here so the deprecation surface is enforced uniformly.
const SURFACES: ReadonlyArray<{ name: string; declFile: string }> = [
  {
    name: "TmuxClient",
    declFile: resolve(repoRoot, "dist/client.d.ts"),
  },
  {
    name: "WebSocketTmuxClient",
    declFile: resolve(repoRoot, "dist/connectors/websocket/client.d.ts"),
  },
  {
    name: "TmuxClientProxy",
    declFile: resolve(repoRoot, "dist/connectors/electron/renderer.d.ts"),
  },
  {
    name: "FakeTmuxClient",
    declFile: resolve(
      repoRoot,
      "packages/pane-terminal/dist/bench/fake-tmux-client.d.ts",
    ),
  },
];

/**
 * Asserts that the JSDoc comment block immediately preceding a `(event|type):
 * "<eventName>"` overload carries `@deprecated`. The check is positional —
 * it walks backwards from the overload to the nearest `/**` opener and
 * verifies `@deprecated` falls between them.
 *
 * Locating overloads by their literal-event signature is robust to formatter
 * choices (multi-line argument lists, trailing-comma style) because we match
 * the *signature start* (`event: "output"` or `type: "output"`) rather than
 * the whole overload string.
 */
function expectOverloadDeprecated(
  source: string,
  surfaceName: string,
  method: "on" | "off",
  eventName: "output" | "extended-output",
): void {
  // Both the library client and the bench fake use `event:`/`type:` for the
  // first parameter; both are matched.
  const sigPattern = new RegExp(
    `\\b(?:event|type)\\s*:\\s*"${eventName}"`,
    "g",
  );
  const matches = [...source.matchAll(sigPattern)];
  expect(
    matches.length,
    `${surfaceName}: expected at least one '"${eventName}"' overload`,
  ).toBeGreaterThan(0);

  // For each occurrence, the preceding JSDoc block must mention @deprecated.
  // `on` and `off` each contribute one occurrence; both must be deprecated.
  // We don't require every occurrence to mention the method name — the
  // ordering invariant (overloads come right after their JSDoc) is enough.
  for (const m of matches) {
    const sigStart = m.index!;
    // Walk back to the nearest /** opener.
    const docStart = source.lastIndexOf("/**", sigStart);
    expect(
      docStart,
      `${surfaceName}.${method}('${eventName}'): no JSDoc precedes the overload`,
    ).toBeGreaterThan(-1);
    const docBlock = source.slice(docStart, sigStart);
    expect(
      docBlock.includes("@deprecated"),
      `${surfaceName}.${method}('${eventName}'): JSDoc preceding the overload is missing @deprecated. Found:\n${docBlock}`,
    ).toBe(true);
    expect(
      docBlock.includes("attachPaneSink"),
      `${surfaceName}.${method}('${eventName}'): JSDoc preceding the overload should name attachPaneSink as the replacement. Found:\n${docBlock}`,
    ).toBe(true);
  }
}

describe("deprecated event overloads on TmuxClient-shaped classes", () => {
  for (const { name, declFile } of SURFACES) {
    it(`${name} advertises @deprecated on on/off('output'|'extended-output')`, () => {
      // Honest failure mode: if the surface hasn't been built yet, fail with
      // a clear message instead of silently swallowing. The agent runbook
      // (`pnpm run build` or `pnpm run typecheck`) regenerates these.
      let source: string;
      try {
        source = readFileSync(declFile, "utf8");
      } catch (err) {
        throw new Error(
          `${name}: declaration file not found at ${declFile}. Run 'pnpm run build' before this test. Cause: ${(err as Error).message}`,
        );
      }

      for (const method of ["on", "off"] as const) {
        for (const eventName of ["output", "extended-output"] as const) {
          expectOverloadDeprecated(source, name, method, eventName);
        }
      }
    });
  }
});
