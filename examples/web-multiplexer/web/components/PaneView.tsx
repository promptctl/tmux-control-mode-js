// examples/web-multiplexer/web/components/PaneView.tsx
//
// The current window, live: the library's `<WindowTerminal>` over the demo's
// bridge adapter. Layout, zoom, seeding, keys and sizing are the library's;
// the demo picks the window and the font size (the − / + above it). The
// window is the person's own
// tmux window, so the page follows tmux's size and declares none.
//
// [LAW:single-enforcer] `store.paneStreamClient` is the one adapter per
//   bridge; every terminal on the page shares it.
// [LAW:one-source-of-truth] The demo's keymap acts on tmux's active pane, so
//   tmux's active pane is the one answer to "which pane am I in": a click
//   (this page's focus moving) selects that pane in tmux, and tmux's active
//   pane moving (a chord, another client) moves this page's focus there. The
//   library keeps the two apart on purpose, for a watcher whose keys must not
//   follow another client's select-pane; this page is the person's own client.

import { useCallback, useMemo, useRef, type ElementRef } from "react";
import { observer } from "mobx-react-lite";
import { ActionIcon, Group, Text, Tooltip } from "@mantine/core";
import type { WindowTerminalState } from "@promptctl/tmux-control-mode-js/window-terminal";
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

interface Seen {
  readonly window: string;
  readonly focus: string;
}

export const PaneView = observer(function PaneView({ store, uiStore }: Props) {
  const win = store.currentWindow;
  const font = uiStore.terminalFontSize;
  const sizing = useMemo(
    () => ({ window: "tmux" as const, font, fit: "none" as const }),
    [font],
  );
  const terminal = useRef<ElementRef<typeof WindowTerminal>>(null);
  const seen = useRef<Seen | null>(null);
  const onState = useCallback(
    (s: WindowTerminalState) => {
      if (s.phase !== "live") return;
      const { id, active, focus, panes } = s.window;
      const prev = seen.current;
      seen.current = { window: id, focus };
      // tmux names a new pane active before the layout that holds it arrives.
      const laidOut = panes.some((p) => p.id === active);
      if (prev?.window !== id) {
        // A window arriving (a switch remounts the terminal): the keyboard
        // goes to tmux's active pane.
        if (laidOut) terminal.current?.focus(active);
      } else if (focus !== prev.focus && focus !== active) {
        // A click: tmux selects that pane.
        const pane = store.currentWindow?.panes.find(
          (p) => `%${p.id}` === focus,
        );
        if (pane !== undefined) store.selectPane(pane);
      } else if (focus !== active && laidOut) {
        terminal.current?.focus(active);
      }
    },
    [store],
  );
  if (win === null) return null;
  return (
    <>
      <Group gap={4} justify="flex-end" wrap="nowrap">
        <Tooltip label="Smaller font">
          <ActionIcon
            size="xs"
            variant="default"
            onClick={() => uiStore.decreaseTerminalFontSize()}
          >
            −
          </ActionIcon>
        </Tooltip>
        <Text size="xs" c="dimmed" ff="monospace" miw={30} ta="center">
          {font}px
        </Text>
        <Tooltip label="Larger font">
          <ActionIcon
            size="xs"
            variant="default"
            onClick={() => uiStore.increaseTerminalFontSize()}
          >
            +
          </ActionIcon>
        </Tooltip>
      </Group>
      <WindowTerminal
        ref={terminal}
        className="demo-window-terminal"
        connection={store.paneStreamClient}
        window={`@${win.id}`}
        sizing={sizing}
        appearance={APPEARANCE}
        onState={onState}
      />
    </>
  );
});
