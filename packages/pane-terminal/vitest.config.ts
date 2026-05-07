import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bench-style gates use `*.bench.ts` to mark them as performance
    // contracts (still run via `it()` + `expect.fail` until impls land).
    // Test-style gates use `*.test.ts` like the rest of the suite.
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "tests/**/*.bench.ts",
    ],
    passWithNoTests: true,
  },
});
