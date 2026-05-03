// examples/web-multiplexer/electron/build.mjs
// Bundles the Electron main+preload TypeScript with esbuild:
//   main.ts      → dist-electron/main.mjs    (ESM, Node target, electron external)
//   preload.ts   → dist-electron/preload.cjs (CJS — required by sandbox:true)
//
// Vite handles the renderer bundle (electron/index.html → dist/electron/),
// so this file only owns the Node-side entrypoints. One toolchain per
// runtime: Vite for browser, esbuild for Node main+preload.

import esbuild from "esbuild";

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: ["electron/main.ts"],
    outfile: "dist-electron/main.mjs",
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["electron"],
    banner: {
      // Node ESM doesn't expose `require` or `__dirname`; main.ts needs
      // both for path-joining the preload script and the renderer HTML.
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
    entryPoints: ["electron/preload.ts"],
    outfile: "dist-electron/preload.cjs",
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["electron"],
  }),
]);
