// Guard: the published package must pull zero runtime dependencies.
// A stray entry in root package.json "dependencies" would leak to every
// npm consumer of tmux-control-mode-js — all runtime code lives under
// src/ and uses only the Node.js standard library.
//
// Runs on prepublishOnly. Fails loudly if a dep sneaks in.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const deps = pkg.dependencies ?? {};
const names = Object.keys(deps);

if (names.length > 0) {
  console.error(
    `✗ root package.json "dependencies" is non-empty — these would leak to every consumer:`,
  );
  for (const n of names) console.error(`    ${n}: ${deps[n]}`);
  console.error(
    `\n  Demo-only deps belong in examples/*/package.json, not the root.`,
  );
  process.exit(1);
}

console.log("✓ root dependencies empty — nothing leaks to npm consumers");
