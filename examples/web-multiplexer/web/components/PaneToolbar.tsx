// examples/web-multiplexer/web/components/PaneToolbar.tsx
//
// Per-pane toolbar shown above each xterm. Displays current pane dimensions
// + font size, and exposes manual font-size controls (− / + buttons) that
// affect ALL pane terminals simultaneously via the UiStore. Font size is
// persisted across reloads.

import { observer } from "mobx-react-lite";
import { Group, Text, Badge, ActionIcon, Tooltip } from "@mantine/core";
import type { PaneInfo } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type { PaneTerminal } from "../pane-terminal.ts";

interface Props {
  readonly pane: PaneInfo;
  readonly uiStore: UiStore;
  readonly terminal: PaneTerminal | null;
}

export const PaneToolbar = observer(function PaneToolbar({
  pane,
  uiStore,
  terminal,
}: Props) {
  const font = terminal?.status.currentFontSize ?? uiStore.terminalFontSize;

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
      <Group gap={4} wrap="nowrap">
        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
          {pane.width}×{pane.height}
        </Text>
        <Tooltip label="Smaller font">
          <ActionIcon
            size="xs"
            variant="default"
            onClick={(e) => {
              e.stopPropagation();
              uiStore.decreaseTerminalFontSize();
            }}
          >
            −
          </ActionIcon>
        </Tooltip>
        <Text
          size="xs"
          c="dimmed"
          style={{ fontFamily: "monospace", minWidth: 30, textAlign: "center" }}
        >
          {font}px
        </Text>
        <Tooltip label="Larger font">
          <ActionIcon
            size="xs"
            variant="default"
            onClick={(e) => {
              e.stopPropagation();
              uiStore.increaseTerminalFontSize();
            }}
          >
            +
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
});
