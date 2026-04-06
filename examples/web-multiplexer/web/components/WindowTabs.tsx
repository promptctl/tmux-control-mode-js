import { observer } from "mobx-react-lite";
import { Tabs, Badge, Group, Text } from "@mantine/core";
import type { DemoStore } from "../store.ts";

interface Props {
  readonly store: DemoStore;
}

export const WindowTabs = observer(function WindowTabs({ store }: Props) {
  const session = store.currentSession;
  if (session === null) return null;
  if (session.windows.length === 0) {
    return <Text c="dimmed">No windows in this session</Text>;
  }
  return (
    <Tabs
      value={store.activeWindowId === null ? undefined : String(store.activeWindowId)}
      onChange={(v) => {
        if (v === null) return;
        store.selectWindow(parseInt(v, 10));
      }}
    >
      <Tabs.List>
        {session.windows.map((w) => (
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
});
