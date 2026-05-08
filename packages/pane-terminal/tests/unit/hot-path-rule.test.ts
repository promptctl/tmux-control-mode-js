// packages/pane-terminal/tests/unit/hot-path-rule.test.ts
//
// Self-test for the no-allocation-in-hot-path ESLint rule. Pairs with Gate 3
// in tests/bench/g3-heap-delta.bench.ts — the rule is the static half of
// that gate's enforcement, and this test guarantees the rule itself works
// before any production code depends on it.

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../../eslint/no-allocation-in-hot-path.js";

// RuleTester drives its case-loop via `describe`/`it`. Vitest globals are
// disabled in this package (deliberate — explicit imports), so hand the
// imported helpers to RuleTester before any cases run.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

// RuleTester.run() must be called at the top level (it spins up its own
// describe/it tree internally). Wrapping it inside another it() throws
// "Calling the suite function inside test function is not allowed".
tester.run("no-allocation-in-hot-path", rule, {
      valid: [
        // No marker → rule does not apply.
        {
          code: `
            function unmarked(b) {
              const arr = [1, 2, 3];
              return arr;
            }
          `,
        },
        // Marked but no allocation.
        {
          code: `
            // [HOT-PATH]
            function onBytes(bytes) {
              counter += bytes.byteLength;
              lastSeen = bytes.byteLength;
            }
          `,
        },
        // Marked; nested function opts out (its allocations are not the marked function's).
        {
          code: `
            // [HOT-PATH]
            function outer() {
              const factory = () => ({ a: 1 });
              return factory;
            }
          `,
        },
      ],
      invalid: [
        {
          code: `
            // [HOT-PATH]
            function bad(bytes) {
              const ev = { size: bytes.byteLength };
              return ev;
            }
          `,
          errors: [{ messageId: "allocation" }],
        },
        {
          code: `
            // [HOT-PATH] arr
            const onBytes = (bytes) => {
              const copy = [...bytes];
              return copy;
            };
          `,
          errors: [
            // ArrayExpression
            { messageId: "allocation" },
            // SpreadElement inside it
            { messageId: "allocation" },
          ],
        },
        {
          code: `
            // [HOT-PATH]
            function bad() {
              return new Map();
            }
          `,
          errors: [{ messageId: "allocation" }],
        },
        {
          code: `
            // [HOT-PATH]
            function bad(items) {
              return items.map((x) => x);
            }
          `,
          errors: [{ messageId: "allocation" }],
        },
        // Expression-bodied arrow — must be analyzed, not silently skipped.
        {
          code: `
            // [HOT-PATH]
            const bad = () => new Map();
          `,
          errors: [{ messageId: "allocation" }],
        },
      ],
    });
