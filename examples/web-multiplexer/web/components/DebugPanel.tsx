import { ScrollArea, Stack, Text, Badge, Group, Code } from "@mantine/core";
import { useMemo, useState } from "react";
import type { SerializedTmuxMessage } from "../../shared/protocol.ts";

interface Props {
  readonly events: readonly SerializedTmuxMessage[];
}

export function DebugPanel({ events }: Props) {
  const [filter, setFilter] = useState<string | null>(null);

  const types = useMemo(() => {
    const s = new Set<string>();
    events.forEach((e) => s.add(e.type));
    return [...s].sort();
  }, [events]);

  const shown = filter === null ? events : events.filter((e) => e.type === filter);

  return (
    <Stack gap="xs">
      <Group gap={4} wrap="wrap">
        <Badge
          size="xs"
          variant={filter === null ? "filled" : "outline"}
          style={{ cursor: "pointer" }}
          onClick={() => setFilter(null)}
        >
          all
        </Badge>
        {types.map((t) => (
          <Badge
            key={t}
            size="xs"
            variant={filter === t ? "filled" : "outline"}
            style={{ cursor: "pointer" }}
            onClick={() => setFilter(t)}
          >
            {t}
          </Badge>
        ))}
      </Group>
      <ScrollArea h="calc(100vh - 180px)" type="auto">
        <Stack gap={2}>
          {shown.map((ev, i) => (
            <Code
              key={i}
              block
              style={{ fontSize: 11, padding: 4, whiteSpace: "pre-wrap", wordBreak: "break-all" }}
            >
              <Text span fw={600} size="xs">
                %{ev.type}
              </Text>{" "}
              {summarize(ev)}
            </Code>
          ))}
          {shown.length === 0 && (
            <Text c="dimmed" size="xs">
              No events yet.
            </Text>
          )}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

function summarize(ev: SerializedTmuxMessage): string {
  const { type, ...rest } = ev as Record<string, unknown> & { type: string };
  // Truncate base64 bodies so the panel stays readable.
  if (typeof rest.dataBase64 === "string" && rest.dataBase64.length > 32) {
    rest.dataBase64 = `<${rest.dataBase64.length} b64 chars>`;
  }
  return JSON.stringify(rest);
}
