# xterm-electron

Reference Electron + xterm.js demo for
`@promptctl/tmux-control-mode-js`. Exercises the Electron IPC bridge
(`src/connectors/electron`) end-to-end: tmux runs in the main process, the
renderer drives an xterm terminal through `TmuxClientProxy`.

**Deliberately thin.** One window, one pane, no tab bar, no fit-addon. Just
enough surface area to prove the IPC bridge + xterm wiring works.

## Architecture

```
┌────────────────────────┐   Electron IPC   ┌──────────────────────┐
│ Main process           │ ───────────────▶ │ Renderer             │
│ spawnTmux() → TmuxClient│ ◀─────────────── │ TmuxClientProxy      │
│ createMainBridge()     │                  │ createRendererBridge │
│                        │                  │ xterm.js Terminal    │
└────────────────────────┘                  └──────────────────────┘
         │                                            ▲
         ▼                                            │
     tmux -C                                        preload.cjs
     (control mode)                                 (contextBridge)
```

The renderer runs with `contextIsolation: true`, `sandbox: true`, and
`nodeIntegration: false`. The preload script exposes a minimal, allowlisted
`window.tmuxIpc` surface (only `tmux:*` channels pass); the library's
`createRendererBridge()` accepts it structurally — no casts, no Node imports
reach the renderer.

## Run

From the repository root, first build the library:

```
npm install
npm run build
```

Then:

```
npm --workspace tmux-control-mode-js-demo-xterm-electron run start
```

This builds the demo and launches Electron. A tmux session named
`xterm-electron-demo` is created on first run (or attached if it already
exists).

## Files

- `main.ts` — Electron main process. Spawns tmux, installs `createMainBridge`.
- `preload.ts` — Sandboxed preload. Exposes `window.tmuxIpc` via `contextBridge`.
- `renderer/main.ts` — Renderer. Uses `createRendererBridge` + xterm.js.
- `index.html` — Renderer shell.
- `build.mjs` — esbuild orchestration (main → ESM, preload → CJS, renderer → browser ESM).
- `tests/e2e.spec.ts` — Playwright Electron test. Launches the app headlessly
  (`TMUX_DEMO_HEADLESS=1` → `BrowserWindow.show: false`), types into xterm, and
  asserts the shell's echo round-trips back through the IPC event channel.

## Test

```
npm --workspace tmux-control-mode-js-demo-xterm-electron run test:e2e
```

Runs in ~1.5 seconds. Proves the full loop end-to-end:
xterm keystroke → IPC invoke → `sendKeys` → tmux → shell echo → `%output`
event → IPC event → `xterm.write` → rendered DOM.
