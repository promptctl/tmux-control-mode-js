// Guard: every file named in the published "exports" map must actually exist
// in the emitted dist/. The package's public surface is the "exports" map (see
// CLAUDE.md: it is the source of truth for what ships); a consumer's
// `import "@promptctl/tmux-control-mode-js/websocket"` resolves to the file
// named there, so a dangling target is a runtime ERR_MODULE_NOT_FOUND for that
// consumer — a defect that npm pack/publish do NOT catch.
//
// Why this exists: `tsc --build` consults *.tsbuildinfo to decide what to emit.
// Mutating dist/ out from under that cache (e.g. `rm -rf dist` without deleting
// the buildinfo) leaves tsc convinced its outputs are current, so it emits
// nothing and still exits 0 — a partial/empty dist that would publish silently.
// [LAW:one-source-of-truth] the buildinfo cache and real dist can disagree;
// this check enforces agreement against the contract (the exports map).
// [LAW:single-enforcer] the export-completeness invariant lives here and only
// here; prepublishOnly forces a clean emit, then runs this as the loud backstop.
//
// Runs on prepublishOnly AFTER the build. Fails loudly, listing every missing
// target, so a dangling export aborts the publish instead of shipping broken.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// An exports entry is a relative path string or a (possibly nested) object of
// condition→value. Collect every leaf path string so coverage doesn't silently
// drop a condition the map happens to use. [FRAMING:representation]
function collectTargets(value, subpath, out) {
  if (typeof value === "string") {
    out.push({ subpath, target: value });
    return;
  }
  for (const [condition, nested] of Object.entries(value)) {
    collectTargets(nested, `${subpath} (${condition})`, out);
  }
}

const targets = [];
for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
  collectTargets(value, subpath, targets);
}

const missing = targets.filter(({ target }) => !existsSync(resolve(root, target)));

if (missing.length > 0) {
  console.error(
    `✗ ${missing.length} of ${targets.length} "exports" target(s) missing from the build:`,
  );
  for (const { subpath, target } of missing) {
    console.error(`    ${subpath} → ${target}`);
  }
  console.error(
    `\n  dist/ is incomplete. Run a true clean emit:\n` +
      `    pnpm run clean && pnpm run build\n` +
      `  (a bare 'pnpm run build' over a stale *.tsbuildinfo can emit nothing.)`,
  );
  process.exit(1);
}

console.log(
  `✓ all ${targets.length} "exports" targets exist in dist — nothing dangling for npm consumers`,
);
