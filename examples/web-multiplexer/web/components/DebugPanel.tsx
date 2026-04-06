// examples/web-multiplexer/web/components/DebugPanel.tsx
// Filterable event stream for the control-mode protocol. Rendered in the
// aside. Category chips toggle visibility (click to hide, click again to
// show); output events are decoded from base64 and labeled by session:win.pane.

import { observer } from "mobx-react-lite";
import { ScrollArea, Stack, Text, Badge, Group, Code, Button } from "@mantine/core";
import { useMemo } from "react";
import type { SerializedTmuxMessage } from "../../shared/protocol.ts";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly uiStore: UiStore;
}

export const DebugPanel = observer(function DebugPanel({ demoStore, uiStore }: Props) {
  const events = demoStore.events;
  const paneLabels = demoStore.paneLabels;

  const types = useMemo(() => {
    const s = new Set<string>();
    events.forEach((e) => s.add(e.type));
    return [...s].sort();
  }, [events]);

  const shown = events.filter((e) => !uiStore.isHidden(e.type));

  return (
    <Stack gap="xs">
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
              {summarize(ev, paneLabels)}
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

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

/**
 * Convert a base64 string to a printable ASCII representation where control
 * characters are escaped (\x1b, \r, \n, etc.) and high bytes are rendered as
 * \xHH. Truncates to a reasonable length so the panel stays scannable.
 */
function prettyBase64(b64: string, max: number = 48): string {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return `<invalid base64: ${b64.slice(0, max)}>`;
  }
  let out = "";
  for (let i = 0; i < bin.length && out.length < max; i++) {
    const c = bin.charCodeAt(i);
    if (c === 0x1b) out += "\\x1b";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c >= 0x20 && c <= 0x7e) out += bin[i];
    else out += `\\x${c.toString(16).padStart(2, "0")}`;
  }
  if (bin.length > max) out += `… (${bin.length} bytes)`;
  return out;
}

function paneLabel(paneId: number, labels: Map<number, string>): string {
  return labels.get(paneId) ?? `%${paneId}`;
}

function summarize(
  ev: SerializedTmuxMessage,
  labels: Map<number, string>,
): string {
  if (ev.type === "output") {
    return `${paneLabel(ev.paneId, labels)}  "${prettyBase64(ev.dataBase64)}"`;
  }
  if (ev.type === "extended-output") {
    return `${paneLabel(ev.paneId, labels)} (age ${ev.age}ms)  "${prettyBase64(ev.dataBase64)}"`;
  }
  if (ev.type === "pause" || ev.type === "continue" || ev.type === "pane-mode-changed") {
    return paneLabel(ev.paneId, labels);
  }
  if (ev.type === "window-pane-changed") {
    return `window @${ev.windowId} active → ${paneLabel(ev.paneId, labels)}`;
  }
  if (ev.type === "window-add" || ev.type === "window-close" || ev.type === "unlinked-window-add" || ev.type === "unlinked-window-close") {
    return `@${ev.windowId}`;
  }
  if (ev.type === "window-renamed" || ev.type === "unlinked-window-renamed") {
    return `@${ev.windowId} → "${ev.name}"`;
  }
  if (ev.type === "layout-change") {
    return `@${ev.windowId} layout=${ev.windowLayout}`;
  }
  if (ev.type === "session-changed" || ev.type === "session-renamed") {
    return `$${ev.sessionId} "${ev.name}"`;
  }
  if (ev.type === "session-window-changed") {
    return `$${ev.sessionId} → @${ev.windowId}`;
  }
  if (ev.type === "client-session-changed") {
    return `${ev.clientName} → $${ev.sessionId} "${ev.name}"`;
  }
  if (ev.type === "client-detached") {
    return ev.clientName;
  }
  if (ev.type === "subscription-changed") {
    return `"${ev.name}" $${ev.sessionId}:@${ev.windowId}.${paneLabel(ev.paneId, labels)} = ${ev.value}`;
  }
  if (ev.type === "begin" || ev.type === "end" || ev.type === "error") {
    return `cmd #${ev.commandNumber}`;
  }
  if (ev.type === "exit") {
    return ev.reason ?? "(clean)";
  }
  if (ev.type === "message") {
    return ev.message;
  }
  if (ev.type === "config-error") {
    return ev.error;
  }
  if (ev.type === "paste-buffer-changed" || ev.type === "paste-buffer-deleted") {
    return ev.name;
  }
  // sessions-changed has no fields
  return "";
}
