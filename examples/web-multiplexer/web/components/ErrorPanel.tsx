import { ScrollArea, Stack, Text, Code } from "@mantine/core";

interface Props {
  readonly errors: readonly string[];
}

export function ErrorPanel({ errors }: Props) {
  if (errors.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No errors.
      </Text>
    );
  }
  return (
    <ScrollArea h="calc(100vh - 180px)" type="auto">
      <Stack gap={4}>
        {errors.map((e, i) => (
          <Code key={i} block color="red" style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
            {e}
          </Code>
        ))}
      </Stack>
    </ScrollArea>
  );
}
