import { NavLink, Stack, Text, Badge, Group } from "@mantine/core";
import type { SessionInfo } from "../state.ts";

interface Props {
  readonly sessions: readonly SessionInfo[];
  readonly activeId: number | null;
  readonly onSelect: (id: number) => void;
}

export function SessionList({ sessions, activeId, onSelect }: Props) {
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
        Sessions
      </Text>
      {sessions.map((s) => (
        <NavLink
          key={s.id}
          active={s.id === activeId}
          onClick={() => onSelect(s.id)}
          label={
            <Group gap="xs" justify="space-between">
              <Text size="sm">{s.name}</Text>
              {s.attached && <Badge size="xs" color="teal" variant="light">attached</Badge>}
            </Group>
          }
          description={`${s.windows.length} window${s.windows.length === 1 ? "" : "s"}`}
        />
      ))}
    </Stack>
  );
}
