// tests/helpers/scripted-window.ts
//
// A scripted tmux for the window terminal's unit tests: one window @1 in the
// attached session, its layout, and the pane records `list-panes -a` reports.
// The engine's tests and the composition's tests drive the same window.

import { FakeTmuxClient } from "./fake-tmux-client.js";
import { TWO_PANES } from "./layout.js";
import { seedStateLine } from "./seed-state.js";
import { parseWindowLayout } from "../../src/protocol/layout.js";
import type { TerminalSink } from "../../src/window-terminal/engine/terminal-sink.js";

export interface World {
  attached: string[];
  all: string[];
  layout: string;
  visible: string;
  flags: string;
  active: string;
}

function paneLine(pane: number, title: string): string {
  return `$1\tmain\t@1\teditor\t%${pane}\t0\t/tmp\t10${pane}\tzsh\tzsh\t40\t24\t${title}`;
}

export function scriptedTmux(world: World): FakeTmuxClient {
  const client = new FakeTmuxClient();
  client.setExecuteResponse((cmd) => {
    if (cmd === "list-windows -F '#{window_id}'")
      return world.attached.join("\n");
    if (cmd === "list-windows -a -F '#{window_id}'")
      return world.all.join("\n");
    if (cmd.startsWith("display-message -p -t @1")) {
      return `${world.layout}\t${world.visible}\t${world.flags}\teditor\t${world.active}\t000`;
    }
    if (cmd.startsWith("list-panes -a")) {
      return [
        paneLine(0, "left"),
        paneLine(1, "right"),
        paneLine(2, "new"),
      ].join("\n");
    }
    // Each pane's state at the size the visible layout gives it, as tmux's.
    const pane = /^display-message -p -t %(\d+) /.exec(cmd);
    if (pane !== null) {
      const layout = parseWindowLayout(world.visible);
      const cell =
        layout.kind === "parsed"
          ? layout.panes.find((p) => p.paneId === Number(pane[1]))
          : undefined;
      if (cell === undefined) throw new Error(`no pane %${pane[1]} in layout`);
      return seedStateLine({ cols: cell.width, rows: cell.height });
    }
    return "";
  });
  return client;
}

export function world(over: Partial<World> = {}): World {
  return {
    attached: ["@1"],
    all: ["@1", "@2"],
    layout: TWO_PANES,
    visible: TWO_PANES,
    flags: "*",
    active: "%1",
    ...over,
  };
}

export class NullSink implements TerminalSink {
  seed(): void {}
  write(): void {}
  resize(): void {}
  clear(): void {}
  isVisible(): boolean {
    return true;
  }
  dispose(): void {}
}
