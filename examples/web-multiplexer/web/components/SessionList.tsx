import { observer } from "mobx-react-lite";
import { NavLink, Stack, Text, Badge, Group } from "@mantine/core";
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
    <Stack gap={2}>
      <Text fw={600} size="xs" c="dimmed" tt="uppercase" pb="xs">
        Sessions ({sessions.length})
      </Text>
      {sessions.map((s) => (
        <NavLink
          key={s.id}
          active={s.id === activeSessionId}
          onClick={() => store.selectSession(s.id)}
          label={
            <Group gap="xs" justify="space-between">
              <Text size="sm">{s.name}</Text>
              {s.attached && (
                <Badge size="xs" color="teal" variant="light">
                  attached
                </Badge>
              )}
            </Group>
          }
          description={`${s.windows.length} window${s.windows.length === 1 ? "" : "s"}`}
        />
      ))}
    </Stack>
  );
});
