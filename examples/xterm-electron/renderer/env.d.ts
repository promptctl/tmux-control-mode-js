// Minimal module declarations so TypeScript accepts CSS-as-side-effect imports
// (esbuild bundles them) and the preload-exposed API typings.

declare module "*.css";

import type { IpcRendererLike } from "@promptctl/tmux-control-mode-js/electron/renderer";

declare global {
  interface Window {
    readonly tmuxIpc: IpcRendererLike;
  }
}

export {};
