// Guard: the published declarations type-check in a browser project.
//
// A browser consumer compiles with the DOM lib and without @types/node, and a
// careful one sets `skipLibCheck: false`, so every declaration it imports must
// name nothing Node-only (`Buffer`, `NodeJS.*`, `node:*` modules). The repo's
// own projects build with `types: ["node"]`, so nothing in the build stops a
// Node name reaching a declaration a browser reads; this check is that stop.
//
// It plays the consumer: a fresh project in a temp dir whose node_modules links
// this package, so every import resolves through the real "exports" map to the
// built dist/*.d.ts. Every export is imported except NODE_ONLY.
// [LAW:one-source-of-truth] the subpaths come from the "exports" map, so a new
// export is checked unless someone decides here that it is Node-only.
//
// The repo has @types/node installed, and a declaration carrying
// `/// <reference types="node" />` would load it and pass; so the check also
// fails when any file under @types/node is in the program. [LAW:no-silent-failure]
//
// Runs in `typecheck` (after the build) and on prepublishOnly.

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

// Subpaths whose API is Node's own types, by design.
const NODE_ONLY = new Set([
  "./streams/node", // adapts Node streams (node:stream Readable/Writable)
]);

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const specifiers = Object.keys(pkg.exports)
  .filter((subpath) => !NODE_ONLY.has(subpath))
  .map((subpath) => pkg.name + subpath.slice(1));

const consumer = mkdtempSync(join(tmpdir(), "browser-types-"));
try {
  const scope = join(consumer, "node_modules", dirname(pkg.name));
  mkdirSync(scope, { recursive: true });
  symlinkSync(root, join(consumer, "node_modules", pkg.name), "dir");
  writeFileSync(
    join(consumer, "main.ts"),
    specifiers
      .map((s, i) => `export type * as m${i} from ${JSON.stringify(s)};\n`)
      .join(""),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ["main.ts"],
    }),
  );

  let output;
  let failed = false;
  try {
    output = execFileSync(
      join(root, "node_modules", ".bin", "tsc"),
      ["-p", consumer, "--listFiles", "--pretty", "false"],
      { encoding: "utf8" },
    );
  } catch (err) {
    if (typeof err.stdout !== "string") throw err;
    output = err.stdout;
    failed = true;
  }

  const lines = output.split("\n");
  const diagnostics = lines.filter((l) => l.includes("error TS"));
  const nodeTypes = lines.filter((l) =>
    l.includes(`${sep}@types${sep}node${sep}`),
  );

  if (failed || nodeTypes.length > 0) {
    console.error(
      `✗ the declarations of ${specifiers.length} browser-facing export(s) do not type-check without Node's types:`,
    );
    for (const d of diagnostics) console.error(`    ${d}`);
    if (nodeTypes.length > 0) {
      console.error(
        `    @types/node was loaded into the program (a \`/// <reference types="node" />\` in a declaration?):`,
      );
      for (const f of nodeTypes.slice(0, 3)) console.error(`      ${f}`);
    }
    if (failed && diagnostics.length === 0) console.error(output);
    console.error(
      `\n  A browser consumer has no @types/node. Use a platform type (Uint8Array,\n` +
        `  not Buffer), or, if the export is Node-only by design, add it to\n` +
        `  NODE_ONLY in scripts/check-browser-types.mjs.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ all ${specifiers.length} browser-facing exports' declarations type-check with the DOM lib and no @types/node`,
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
