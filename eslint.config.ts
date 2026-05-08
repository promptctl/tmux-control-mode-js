import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import noAllocationInHotPath from "./packages/pane-terminal/eslint/no-allocation-in-hot-path.js";

// [LAW:single-enforcer] One ESLint config registers every cross-cutting
// invariant we mechanically enforce. The hot-path rule pairs with Gate 3 in
// `packages/pane-terminal/tests/bench/g3-heap-delta.bench.ts` — runtime heap
// delta is the dynamic check; this rule is the static check on
// `// [HOT-PATH]`-marked function bodies.
const paneTerminal = {
  rules: {
    "no-allocation-in-hot-path": noAllocationInHotPath,
  },
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  eslintConfigPrettier,
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "**/dist/**",
      "packages/pane-terminal/eslint/**",
    ],
  },
  {
    plugins: { "pane-terminal": paneTerminal },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "pane-terminal/no-allocation-in-hot-path": "error",
    },
  },
);
