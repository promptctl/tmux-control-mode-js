import { observer } from "mobx-react-lite";
import { ScrollArea, Stack, Text, Code, Group, Button } from "@mantine/core";
import { useState } from "react";
import type { DemoStore } from "../store.ts";

interface Props {
  readonly demoStore: DemoStore;
}

export const ErrorPanel = observer(function ErrorPanel({ demoStore }: Props) {
  const errors = demoStore.errors;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  async function copyToClipboard(): Promise<void> {
    // Errors are stored newest-first; copy chronologically.
    const text = [...errors].reverse().join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 1500);
    }
  }

  return (
    <Stack gap="xs">
      <Group gap="xs" justify="space-between">
        <Text size="xs" c="dimmed">
          {errors.length} error{errors.length === 1 ? "" : "s"}
        </Text>
        <Group gap={4}>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => void copyToClipboard()}
            disabled={errors.length === 0}
          >
            {copyState === "copied"
              ? "copied!"
              : copyState === "error"
              ? "copy failed"
              : "copy"}
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            color="red"
            onClick={() => demoStore.clearErrors()}
            disabled={errors.length === 0}
          >
            clear
          </Button>
        </Group>
      </Group>
      {errors.length === 0 ? (
        <Text c="dimmed" size="sm">
          No errors.
        </Text>
      ) : (
        <ScrollArea h="calc(100vh - 200px)" type="auto">
          <Stack gap={4}>
            {errors.map((e, i) => (
              <Code
                key={i}
                block
                color="red"
                style={{ fontSize: 11, whiteSpace: "pre-wrap" }}
              >
                {e}
              </Code>
            ))}
          </Stack>
        </ScrollArea>
      )}
    </Stack>
  );
});
