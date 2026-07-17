import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // This config drives the package's own `bench:gate` script (unit +
    // perf gates together). The canonical `test:all` run pulls only the
    // unit files (tests/unit) via the root vitest.config.ts include; the
    // *.bench.ts perf gates are slow real-tmux + --expose-gc contracts kept
    // off the default local path and exercised here / in `bench:gate`.
    // Bench-style gates use `*.bench.ts`; test-style gates use `*.test.ts`.
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "tests/**/*.bench.ts",
    ],
    // No passWithNoTests: a tests/ rename or glob typo that collects zero
    // files must fail loudly, not exit 0 green. [LAW:no-silent-failure]
  },
});
