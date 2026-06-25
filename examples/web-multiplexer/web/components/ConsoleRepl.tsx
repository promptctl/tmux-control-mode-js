// examples/web-multiplexer/web/components/ConsoleRepl.tsx
//
// The REPL half of the Console tab (tmux-showcase-bhx.25.2): an input that
// drives `bridge.execute` through `ConsoleStore.submit`, a scrollable history
// of result rows, Up/Down recall over persisted command history, and a clear
// button. The component owns only view state — the input string and the scroll
// position. Every result row is a discriminated `ReplEntry` the store owns;
// this component matches on `status` to render and never decides outcomes.
// [LAW:one-source-of-truth] the store is the authority; the view is a projection.

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import {
  Box,
  Button,
  CopyButton,
  Group,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import type { ConsoleStore } from "../console-store.ts";
import type { RecallStep, ReplEntry } from "../console-types.ts";

interface Props {
  readonly store: ConsoleStore;
}

const MONO = "var(--mantine-font-family-monospace)";

/** Latency colour bands per the Console design doc: ≤25ms green, ≤200ms yellow, else red. */
function latencyColor(ms: number): string {
  if (ms <= 25) return "green.7";
  if (ms <= 200) return "yellow.8";
  return "red.7";
}

function formatMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** What clicking a row copies: the command, then its output or error body. */
function copyText(entry: ReplEntry): string {
  if (entry.status === "ok") return [entry.command, ...entry.output].join("\n");
  if (entry.status === "error") return `${entry.command}\n${entry.message}`;
  return entry.command;
}

function ReplRow({ entry }: { readonly entry: ReplEntry }): React.JSX.Element {
  const isError = entry.status === "error";
  return (
    <CopyButton value={copyText(entry)}>
      {({ copied, copy }) => (
        <Box
          onClick={copy}
          title="Click to copy"
          style={{
            cursor: "pointer",
            borderLeft: `3px solid ${
              isError ? "var(--mantine-color-red-6)" : "var(--mantine-color-default-border)"
            }`,
            paddingLeft: "var(--mantine-spacing-xs)",
            paddingTop: 2,
            paddingBottom: 2,
          }}
        >
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Text size="sm" style={{ fontFamily: MONO }} truncate>
              <Text span c="dimmed">{`#${entry.id + 1} `}</Text>
              {entry.command}
            </Text>
            <RowMeta entry={entry} copied={copied} />
          </Group>
          <RowBody entry={entry} />
        </Box>
      )}
    </CopyButton>
  );
}

function RowMeta({
  entry,
  copied,
}: {
  readonly entry: ReplEntry;
  readonly copied: boolean;
}): React.JSX.Element {
  if (copied) {
    return (
      <Text size="xs" c="teal" style={{ whiteSpace: "nowrap" }}>
        copied
      </Text>
    );
  }
  if (entry.status === "pending") {
    return (
      <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
        running…
      </Text>
    );
  }
  return (
    <Group gap={4} wrap="nowrap">
      <Text size="xs" c={latencyColor(entry.latencyMs)} style={{ whiteSpace: "nowrap" }}>
        {formatMs(entry.latencyMs)}
      </Text>
      <Text size="xs" c={entry.status === "error" ? "red.7" : "green.7"}>
        {entry.status === "error" ? "✗" : "✓"}
      </Text>
    </Group>
  );
}

function RowBody({ entry }: { readonly entry: ReplEntry }): React.JSX.Element | null {
  if (entry.status === "pending") return null;
  if (entry.status === "error") {
    return (
      <Text size="sm" c="red.7" style={{ fontFamily: MONO, whiteSpace: "pre-wrap" }}>
        {entry.message}
      </Text>
    );
  }
  if (entry.output.length === 0) {
    return (
      <Text size="sm" c="dimmed" style={{ fontFamily: MONO }}>
        (no output)
      </Text>
    );
  }
  return (
    <Text size="sm" style={{ fontFamily: MONO, whiteSpace: "pre-wrap" }}>
      {entry.output.join("\n")}
    </Text>
  );
}

export const ConsoleRepl = observer(function ConsoleRepl({ store }: Props) {
  const [input, setInput] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const rowCount = store.replEntries.length;

  // The component is the sole owner of scroll position; pin to the newest row
  // when one is appended. [LAW:no-ambient-temporal-coupling] the effect keyed on
  // row count is the named scheduler, not an incidental render side effect.
  useEffect(() => {
    const el = viewport.current;
    if (el !== null) el.scrollTo({ top: el.scrollHeight });
  }, [rowCount]);

  function handleSubmit(): void {
    void store.submit(input);
    setInput("");
  }

  function applyRecall(step: RecallStep): void {
    if (step.kind === "command") setInput(step.text);
    else if (step.kind === "live") setInput("");
    // "none" → boundary; leave the input as the user has it.
  }

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Group justify="space-between">
        <Group gap="xs" align="baseline">
          <Title order={5}>REPL</Title>
          <Text size="xs" c="dimmed">
            {store.commandHistory.length} in recall
          </Text>
        </Group>
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          onClick={() => store.clear()}
          disabled={rowCount === 0}
        >
          clear
        </Button>
      </Group>

      <ScrollArea viewportRef={viewport} style={{ flex: 1, minHeight: 0 }}>
        {rowCount === 0 ? (
          <Text size="sm" c="dimmed">
            Type a tmux command below — e.g. <code>list-sessions</code> — and see the
            response with timing. Up/Down recalls history.
          </Text>
        ) : (
          <Stack gap={2}>
            {store.replEntries.map((entry) => (
              <ReplRow key={entry.id} entry={entry} />
            ))}
          </Stack>
        )}
      </ScrollArea>

      <Group gap="xs" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          placeholder="tmux command"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleSubmit();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              applyRecall(store.recallPrevious());
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              applyRecall(store.recallNext());
            }
          }}
          styles={{ input: { fontFamily: MONO } }}
        />
        <Button onClick={handleSubmit}>Send</Button>
      </Group>
    </Stack>
  );
});
