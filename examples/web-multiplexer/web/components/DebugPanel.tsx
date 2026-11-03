// examples/web-multiplexer/web/components/DebugPanel.tsx
// Filterable event stream for the control-mode protocol. Rendered in the
// aside. Category chips toggle visibility (click to hide, click again to
// show); output bytes arrive as decoded Uint8Array, labeled by session:win.pane.
//
// [LAW:one-source-of-truth] Events are the `in-event` slice of
// InspectorStore.entries — the one ring fed by `onWire` — not a second
// subscription of their own. SD5 (tmux-complexity-lkg.15) retired the
// parallel ring DemoStore/LogStore used to keep.

import { observer } from "mobx-react-lite";
import {
  ScrollArea,
  Stack,
  Text,
  Badge,
  Group,
  Code,
  Button,
} from "@mantine/core";
import { useMemo, useState } from "react";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type { InspectorStore } from "../inspector-store.ts";
import { summarizeEvent } from "../event-summary.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly uiStore: UiStore;
  readonly inspectorStore: InspectorStore;
}

export const DebugPanel = observer(function DebugPanel({
  demoStore,
  uiStore,
  inspectorStore,
}: Props) {
  const paneLabels = demoStore.paneLabels;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  // A MobX computed (see its header comment) — not a React `useMemo`.
  // `entries` is mutated in place on InspectorStore's hot path, so a
  // `useMemo` keyed on its reference would never see it change.
  const events = inspectorStore.eventMessages;

  const types = useMemo(() => {
    const s = new Set<string>();
    events.forEach((e) => s.add(e.type));
    return [...s].sort();
  }, [events]);

  const shown = events.filter((e) => !uiStore.isHidden(e.type));

  async function copyToClipboard(): Promise<void> {
    // Render the visible events to plain text using the same one-line
    // summarizer the panel uses on screen, then write to the clipboard.
    // Reverse so the copied output is chronological (oldest → newest)
    // since we display newest-first on screen.
    const text = [...shown]
      .reverse()
      .map((ev) => `%${ev.type} ${summarizeEvent(ev, paneLabels)}`)
      .join("\n");
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
          {shown.length} of {events.length} shown
        </Text>
        <Group gap={4}>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => void copyToClipboard()}
            disabled={shown.length === 0}
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
            // Clears the one shared wire-log ring (InspectorStore), not just
            // this view's filtered slice — the Inspector tab's timeline
            // empties too. [LAW:one-source-of-truth]
            onClick={() => inspectorStore.clear()}
            disabled={events.length === 0}
          >
            clear
          </Button>
        </Group>
      </Group>
      <Group gap={4} wrap="wrap">
        {types.map((t) => {
          const hidden = uiStore.isHidden(t);
          return (
            <Badge
              key={t}
              size="xs"
              variant={hidden ? "outline" : "filled"}
              color={hidden ? "gray" : "teal"}
              style={{ cursor: "pointer", opacity: hidden ? 0.45 : 1 }}
              onClick={() => uiStore.toggleEventType(t)}
              title={hidden ? `Click to show ${t}` : `Click to hide ${t}`}
            >
              {t}
            </Badge>
          );
        })}
        {Object.keys(uiStore.hiddenEventTypes).length > 0 && (
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => uiStore.clearHidden()}
          >
            show all
          </Button>
        )}
      </Group>
      <ScrollArea h="calc(100vh - 200px)" type="auto">
        <Stack gap={2}>
          {shown.map((ev, i) => (
            <Code
              key={i}
              block
              style={{
                fontSize: 11,
                padding: 4,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              <Text span fw={600} size="xs">
                %{ev.type}
              </Text>{" "}
              {summarizeEvent(ev, paneLabels)}
            </Code>
          ))}
          {shown.length === 0 && (
            <Text c="dimmed" size="xs">
              No events match the current filter.
            </Text>
          )}
        </Stack>
      </ScrollArea>
    </Stack>
  );
});
