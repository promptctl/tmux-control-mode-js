// examples/web-multiplexer/web/components/PaneView.tsx
//
// The current window, live: the library's `<WindowTerminal>` over the demo's
// bridge adapter. Layout, zoom, seeding, keys and sizing are the library's;
// the demo picks the window and the font size. The window is the person's own
// tmux window, so the page follows tmux's size and declares none.
//
// [LAW:single-enforcer] `store.paneStreamClient` is the one adapter per
//   bridge; every terminal on the page shares it.

import { useMemo } from "react";
import { observer } from "mobx-react-lite";
import { WindowTerminal } from "@promptctl/tmux-control-mode-js/window-terminal/react";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";

const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';
const APPEARANCE = { fontFamily: FONT_FAMILY } as const;

interface Props {
  readonly store: DemoStore;
  readonly uiStore: UiStore;
}

export const PaneView = observer(function PaneView({ store, uiStore }: Props) {
  const win = store.currentWindow;
  const font = uiStore.terminalFontSize;
  const sizing = useMemo(
    () => ({ window: "tmux" as const, font, fit: "none" as const }),
    [font],
  );
  if (win === null) return null;
  return (
    <WindowTerminal
      className="demo-window-terminal"
      connection={store.paneStreamClient}
      window={`@${win.id}`}
      sizing={sizing}
      appearance={APPEARANCE}
    />
  );
});
