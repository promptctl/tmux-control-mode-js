import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: [
      "src/**/*.test.ts",
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      // Pure, package-independent demo logic (trigram index, ANSI→text).
      // These import no browser/DOM/React deps, so they run under the same
      // node test env and keep `test:all` the single canonical command.
      "examples/web-multiplexer/web/*.test.ts",
    ],
  },
});
