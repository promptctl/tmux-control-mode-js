// examples/web-multiplexer/web/electron-bridge.ts
// The Electron entry's bridge: the library's renderer-side `TmuxClientProxy`
// over the preload's `tmuxIpc`, and the firehose over the demo's own IPC.

import {
  createRendererBridge,
  type IpcRendererLike,
} from "@promptctl/tmux-control-mode-js/electron/renderer";
import type { DemoIpc } from "./demo-ipc.ts";
import { LibraryBridge } from "./library-bridge.ts";

export function electronBridge(
  ipcRenderer: IpcRendererLike,
  demoIpc: DemoIpc,
): LibraryBridge {
  return new LibraryBridge(
    () => createRendererBridge(ipcRenderer),
    (sink, reportError) => {
      // One IPC subscription for the page's lifetime; the main process taps
      // panes only between start and stop.
      demoIpc.onFirehose(sink);
      const report = (err: unknown): void =>
        reportError(err instanceof Error ? err.message : String(err));
      return {
        start: () => {
          demoIpc.startFirehose().catch(report);
        },
        stop: () => {
          demoIpc.stopFirehose().catch(report);
        },
      };
    },
  );
}
