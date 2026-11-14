// Guard: what the published package asks of a consumer's dependency tree.
//
// - "dependencies" is empty. Every entry would be installed into every npm
//   consumer's tree; all runtime code lives under src/ and uses only the
//   platform (Node standard library, or the DOM in window-terminal).
// - "peerDependencies" is exactly EXPECTED_PEERS, each `optional: true` in
//   "peerDependenciesMeta". The peers serve opt-in subpaths (xterm.js for the
//   window-terminal renderer, React for its React shell); a consumer of any
//   other subpath must not be asked to install them. Adding a peer is a
//   release decision, so it must edit EXPECTED_PEERS here.
// - "peerDependenciesMeta" names no package that is not a peer.
// - Every peer is also a devDependency, so this repo builds and tests against
//   the peer it declares.
//
// "devDependencies" are otherwise out of scope: they do not ship to consumers.
// Runs in CI and on prepublishOnly. Every failure is reported, loudly, naming
// the offending package.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const EXPECTED_PEERS = ["@xterm/xterm", "react"];

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const deps = pkg.dependencies ?? {};
const peers = pkg.peerDependencies ?? {};
const peerMeta = pkg.peerDependenciesMeta ?? {};
const devDeps = pkg.devDependencies ?? {};

const failures = [];

for (const [name, range] of Object.entries(deps)) {
  failures.push(
    `"dependencies" has ${name}@${range} — it would leak to every consumer (demo-only deps belong in examples/*/package.json)`,
  );
}

const peerNames = Object.keys(peers).sort();
for (const name of peerNames) {
  if (!EXPECTED_PEERS.includes(name)) {
    failures.push(
      `"peerDependencies" has unexpected ${name} — adding a peer is a release decision; edit EXPECTED_PEERS in scripts/check-no-deps.mjs`,
    );
  }
  if (peerMeta[name]?.optional !== true) {
    failures.push(
      `peer ${name} is not \`optional: true\` in "peerDependenciesMeta" — consumers who never import its subpath would be asked to install it`,
    );
  }
  if (!(name in devDeps)) {
    failures.push(
      `peer ${name} is not in "devDependencies" — this repo would not build or test against it`,
    );
  }
}
for (const name of EXPECTED_PEERS) {
  if (!(name in peers)) {
    failures.push(
      `expected peer ${name} is missing from "peerDependencies" — removing a peer is a release decision; edit EXPECTED_PEERS in scripts/check-no-deps.mjs`,
    );
  }
}
for (const name of Object.keys(peerMeta)) {
  if (!(name in peers)) {
    failures.push(
      `"peerDependenciesMeta" names ${name}, which is not a peer — orphan metadata`,
    );
  }
}

if (failures.length > 0) {
  console.error("✗ root package.json dependency surface is wrong:");
  for (const f of failures) console.error(`    ${f}`);
  process.exit(1);
}

console.log(
  `✓ root dependencies empty; peers exactly [${EXPECTED_PEERS.join(", ")}], all optional and devDependencies`,
);
