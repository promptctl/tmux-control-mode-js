// examples/web-multiplexer/web/components/PaneToolbar.tsx
//
// Per-pane toolbar shown above each xterm. Displays the current tmux pane
// dimensions and exposes a "Resize pane to fit browser" button that uses
// the library to drive tmux (not just observe it). When the pane is
// oversized for its container — meaning the rendered font had to drop
// below 10 px to avoid horizontal clipping — the button is highlighted
// with a teal pulse to invite the user to resize.

import { observer } from "mobx-react-lite";
import { Group, Text, Button, Badge, Tooltip } from "@mantine/core";
import type { DemoStore, PaneInfo } from "../store.ts";
import type { PaneTerminal } from "../pane-terminal.ts";
import { comfortableDimensionsForContainer } from "../pane-terminal.ts";

interface Props {
  readonly pane: PaneInfo;
  readonly store: DemoStore;
  readonly terminal: PaneTerminal | null;
}

export const PaneToolbar = observer(function PaneToolbar({
  pane,
  store,
  terminal,
}: Props) {
  const font = terminal?.status.currentFontSize ?? null;
  const oversized = terminal?.status.oversized === true;

  function handleResize(): void {
    if (terminal === null) return;
    const { w, h } = terminal.containerDimensions;
    if (w <= 0 || h <= 0) return;
    const { cols, rows } = comfortableDimensionsForContainer(w, h);
    store.resizePane(pane.id, cols, rows);
  }

  return (
    <Group gap="xs" justify="space-between" pb={4} wrap="nowrap">
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <Text size="xs" c="dimmed" truncate="end">
          %{pane.id} ({pane.index}) {pane.title}
        </Text>
        {pane.active && (
          <Badge size="xs" color="teal" variant="light">
            active
          </Badge>
        )}
      </Group>
      <Group gap="xs" wrap="nowrap">
        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
          {pane.width}×{pane.height}
          {font !== null && ` · ${font}px`}
        </Text>
        <Tooltip
          label={
            oversized
              ? "Pane is too big for this cell — click to ask tmux to resize"
              : "Resize tmux pane to match this cell at a comfortable font size"
          }
        >
          <Button
            size="compact-xs"
            variant={oversized ? "filled" : "default"}
            color={oversized ? "teal" : undefined}
            onClick={handleResize}
          >
            Resize
          </Button>
        </Tooltip>
      </Group>
    </Group>
  );
});
