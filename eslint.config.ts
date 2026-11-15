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

const REACT_ONLY = "Only src/window-terminal/react/** may import React.";
const XTERM_ONLY =
  "Only src/window-terminal/render/** and react/** may import xterm.js.";

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
  // Likewise only window-terminal's render/ and react/ may import xterm.js, so
  // `.`, every other subpath and the window engine never need the peer.
  {
    files: ["src/**"],
    ignores: ["src/window-terminal/react/**", "src/window-terminal/render/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: REACT_ONLY },
            { name: "react-dom", message: REACT_ONLY },
          ],
          patterns: [
            { group: ["react/*", "react-dom/*"], message: REACT_ONLY },
            { group: ["@xterm/*"], message: XTERM_ONLY },
          ],
        },
      ],
    },
  },
  {
    files: ["src/window-terminal/render/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: REACT_ONLY },
            { name: "react-dom", message: REACT_ONLY },
          ],
          patterns: [
            { group: ["react/*", "react-dom/*"], message: REACT_ONLY },
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
