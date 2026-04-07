// examples/web-multiplexer/web/components/PaneToolbar.tsx
//
// Per-pane toolbar shown above each xterm. Displays the current tmux pane
// dimensions and exposes a single "Resize" button that does the obvious
// right thing in either direction:
//
//   - If the tmux pane is too big to fit at a readable font, the button
//     SHRINKS the pane until it fills the browser cell at the maximum
//     readable font size (16 px).
//   - If the tmux pane is small (rendering at 16 px in a much larger
//     cell), the button GROWS the pane until it fills the browser cell
//     at 16 px.
//
// Both directions converge on the same target: tmux pane = max cols × rows
// that fits the cell at 16 px. The button is "do what I want" — one click,
// always correct.

import { observer } from "mobx-react-lite";
import { Group, Text, Button, Badge, Tooltip } from "@mantine/core";
import type { DemoStore, PaneInfo } from "../store.ts";
import type { PaneTerminal } from "../pane-terminal.ts";
import { dimensionsForContainer } from "../pane-terminal.ts";

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
    const { cols, rows } = dimensionsForContainer(w, h);
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
        <Tooltip label="Resize tmux pane to fit this cell at the maximum readable font size">
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
