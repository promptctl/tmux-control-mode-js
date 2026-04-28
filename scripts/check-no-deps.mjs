// Guard: the published package must pull zero runtime dependencies.
// A stray entry in root package.json "dependencies" would leak to every
// npm consumer of tmux-control-mode-js — all runtime code lives under
// src/ and uses only the Node.js standard library.
//
// Scope: this script intentionally checks ONLY "dependencies" — those are
// what `npm install tmux-control-mode-js` pulls into a consumer's tree.
// "devDependencies" and "peerDependencies" are out of scope by design:
// devDependencies do not ship to consumers, and the package today exposes
// no peer surface. If you add a peerDependency, extend this script to
// validate its shape (or rename to reflect the broader scope).
//
// Runs on prepublishOnly. Fails loudly if a runtime dep sneaks in.

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
