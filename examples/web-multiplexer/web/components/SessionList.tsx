import { observer } from "mobx-react-lite";
import { NavLink, Stack, Text, Badge, Group, ScrollArea } from "@mantine/core";
import type { DemoStore } from "../store.ts";

interface Props {
  readonly store: DemoStore;
}

export const SessionList = observer(function SessionList({ store }: Props) {
  const { sessions, activeSessionId } = store;

  if (sessions.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No sessions
      </Text>
    );
  }
  return (
    <Stack gap={0} h="100%" style={{ minHeight: 0 }}>
      <Text fw={600} size="xs" c="dimmed" tt="uppercase" pb="xs">
        Sessions ({sessions.length})
      </Text>
      <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
        <Stack gap={2}>
          {sessions.map((s) => (
            <NavLink
              key={s.id}
              active={s.id === activeSessionId}
              onClick={() => store.selectSession(s.id)}
              py={4}
              label={
                <Group gap={6} wrap="nowrap" justify="space-between">
                  <Text size="xs" truncate="end" style={{ flex: 1, minWidth: 0 }}>
                    {s.name}
                  </Text>
                  <Badge
                    size="xs"
                    variant={s.attached ? "filled" : "light"}
                    color={s.attached ? "teal" : "gray"}
                  >
                    {s.windows.length}
                  </Badge>
                </Group>
              }
            />
          ))}
        </Stack>
      </ScrollArea>
    </Stack>
  );
});
