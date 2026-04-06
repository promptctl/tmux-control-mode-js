import { Tabs, Badge, Group, Text } from "@mantine/core";
import type { WindowInfo } from "../state.ts";
import type { BridgeClient } from "../ws-client.ts";

interface Props {
  readonly windows: readonly WindowInfo[];
  readonly activeId: number | null;
  readonly onSelect: (id: number) => void;
  readonly sessionName: string;
  readonly client: BridgeClient;
}

export function WindowTabs({ windows, activeId, onSelect, sessionName, client }: Props) {
  if (windows.length === 0) {
    return <Text c="dimmed">No windows in this session</Text>;
  }
  return (
    <Tabs
      value={activeId === null ? undefined : String(activeId)}
      onChange={(v) => {
        if (v === null) return;
        const id = parseInt(v, 10);
        onSelect(id);
        // Make tmux switch the active window too so the view matches the
        // user's actual session state.
        const w = windows.find((x) => x.id === id);
        if (w !== undefined) {
          void client.execute(`select-window -t ${sessionName}:${w.index}`);
        }
      }}
    >
      <Tabs.List>
        {windows.map((w) => (
          <Tabs.Tab key={w.id} value={String(w.id)}>
            <Group gap="xs">
              <Text size="sm">
                {w.index}: {w.name}
              </Text>
              <Badge size="xs" variant="outline">
                {w.panes.length}
              </Badge>
            </Group>
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
}
