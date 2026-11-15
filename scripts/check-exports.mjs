// Guard: every file named in the published "exports" map must actually be in
// the packed tarball. The package's public surface is the "exports" map (see
// CLAUDE.md: it is the source of truth for what ships); a consumer's
// `import "@promptctl/tmux-control-mode-js/websocket"` resolves to the file
// named there, so a dangling target is a runtime ERR_MODULE_NOT_FOUND for that
// consumer — a defect that npm pack/publish do NOT catch.
//
// Why this exists: `tsc --build` consults *.tsbuildinfo to decide what to emit.
// Mutating dist/ out from under that cache (e.g. `rm -rf dist` without deleting
// the buildinfo) leaves tsc convinced its outputs are current, so it emits
// nothing and still exits 0 — a partial/empty dist that would publish silently.
// A file can also exist in dist/ and still not ship: the "files" field can
// exclude it (e.g. "!dist/window-terminal"). So targets are resolved against
// the file list `npm pack --dry-run --json` reports, never the filesystem.
// [LAW:one-source-of-truth] the buildinfo cache, real dist, and the tarball can
// all disagree; this check enforces agreement between the contract (the
// exports map) and what actually ships (the pack list).
// [LAW:single-enforcer] the export-completeness invariant lives here and only
// here; prepublishOnly forces a clean emit, then runs this as the loud backstop.
//
// Runs on prepublishOnly AFTER the build. Fails loudly, listing every missing
// target, so a dangling export aborts the publish instead of shipping broken.
//
// The repo publishes one package — the root — so the exports map checked is
// the root package.json's.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";

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

// npm pack's own view of the tarball. No prepack/prepare script exists, so
// this lists files without building anything.
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
const shipped = new Set(packed.files.map((f) => f.path));

const missing = targets.filter(
  ({ target }) => !shipped.has(posix.normalize(target)),
);

if (missing.length > 0) {
  console.error(
    `✗ ${missing.length} of ${targets.length} "exports" target(s) missing from the packed tarball:`,
  );
  for (const { subpath, target } of missing) {
    console.error(`    ${subpath} → ${target} (not in npm pack's file list)`);
  }
  console.error(
    `\n  Either package.json "files" excludes it, or dist/ is incomplete.\n` +
      `  For the latter, run a true clean emit:\n` +
      `    pnpm run clean && pnpm run build\n` +
      `  (a bare 'pnpm run build' over a stale *.tsbuildinfo can emit nothing.)`,
  );
  process.exit(1);
}

console.log(
  `✓ all ${targets.length} "exports" targets are in the packed tarball — nothing dangling for npm consumers`,
);
