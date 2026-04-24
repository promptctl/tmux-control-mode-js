// examples/xterm-electron/build.mjs
// Bundles the three Electron entry points with esbuild:
//   main.ts       → dist/main.mjs     (ESM, Node target, electron external)
//   preload.ts    → dist/preload.cjs  (CJS — required by sandbox:true)
//   renderer/main → dist/renderer.js  (ESM, browser target, bundles xterm)
//
// Keeps the tooling surface to one file and one runtime dev-dep (esbuild).

import esbuild from "esbuild";

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: ["main.ts"],
    outfile: "dist/main.mjs",
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["electron"],
    banner: {
      // Node ESM doesn't expose `require` or `__dirname`; the main process
      // needs both for path-joining the preload script. Shim via createRequire.
      js:
        "import { createRequire as __cr } from 'module';" +
        "import { fileURLToPath as __f2p } from 'url';" +
        "import { dirname as __dn } from 'path';" +
        "const require = __cr(import.meta.url);" +
        "const __filename = __f2p(import.meta.url);" +
        "const __dirname = __dn(__filename);",
    },
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["preload.ts"],
    outfile: "dist/preload.cjs",
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["electron"],
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["renderer/main.ts"],
    outfile: "dist/renderer.js",
    platform: "browser",
    target: "es2022",
    format: "esm",
    loader: { ".css": "css" },
  }),
]);
