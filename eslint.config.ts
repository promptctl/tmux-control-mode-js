import { fileURLToPath } from "node:url";
import { includeIgnoreFile } from "@eslint/compat";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import noAllocationInHotPath from "./eslint/rules/no-allocation-in-hot-path.js";

// [LAW:single-enforcer] One ESLint config registers every cross-cutting
// invariant we mechanically enforce. The hot-path rule pairs with Gate 3 in
// `tests/bench/g3-heap-delta.bench.ts` — runtime heap delta is the dynamic
// check; this rule is the static check on `// [HOT-PATH]`-marked function
// bodies.
const hotPath = {
  rules: {
    "no-allocation": noAllocationInHotPath,
  },
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  eslintConfigPrettier,
  // [LAW:one-source-of-truth] .gitignore decides what is not source, as it
  // does for prettier; ESLint does not read it on its own.
  includeIgnoreFile(fileURLToPath(new URL(".gitignore", import.meta.url))),
  {
    ignores: ["eslint/**"],
  },
  {
    plugins: { "hot-path": hotPath },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "hot-path/no-allocation": "error",
    },
  },
  // [LAW:one-way-deps] Only window-terminal/react may import React, so no
  // engine/render/sizing `.d.ts` can reach `react` and a consumer without
  // React still typechecks. Backstop to the separate react tsconfig project.
  {
    files: ["src/window-terminal/**"],
    ignores: ["src/window-terminal/react/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              message: "Only src/window-terminal/react/** may import React.",
            },
          ],
          patterns: [
            {
              group: ["react/*"],
              message: "Only src/window-terminal/react/** may import React.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.mjs", "scripts/**"],
    languageOptions: { globals: globals.node },
  },
  // [LAW:no-defensive-null-guards] In a test a wrong `!` dereferences
  // undefined and throws, failing the test loudly — the outcome these rules
  // exist to force. An empty callback in a test is a deliberate no-op sink.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/tests/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
);
