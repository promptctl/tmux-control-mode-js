// examples/web-multiplexer/web/components/InspectorView.tsx
//
// Protocol Inspector — the "Wireshark for tmux control mode".
//
// Layout: toolbar on top, split view below (timeline list on the left,
// detail panel on the right). Pure projection of InspectorStore — the
// component holds no local state beyond what it reads from MobX.
//
// [LAW:one-source-of-truth] All filter state, selection, and entry
// data come from InspectorStore. The view never caches derived values.
//
// [LAW:dataflow-not-control-flow] The row renderer is the same for
// every entry. Per-direction variation lives in data (icon, color,
// summary string) — not in control flow branches that render different
// JSX per type.

import { observer } from "mobx-react-lite";
import {
  Group,
  Stack,
  Text,
  Badge,
  Button,
  TextInput,
  ScrollArea,
  Code,
  Paper,
  Divider,
  ActionIcon,
  Tooltip,
} from "@mantine/core";
import type { InspectorStore, InspectorEntry } from "../inspector-store.ts";
import type { WireEntry } from "../bridge.ts";
import type { SerializedTmuxMessage } from "../../shared/protocol.ts";
import type { DemoStore } from "../store.ts";

interface Props {
  readonly store: InspectorStore;
  readonly demoStore: DemoStore;
}

export const InspectorView = observer(function InspectorView({
  store,
  demoStore,
}: Props) {
  const visible = store.visibleEntries;
  const counts = store.counts;
  const paneLabels = demoStore.paneLabels;

  return (
    <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
      {/* --------------------------- Toolbar --------------------------- */}
      <Paper withBorder p="xs">
        <Group gap="xs" wrap="wrap">
          <Button
            size="compact-sm"
            variant={store.paused ? "filled" : "default"}
            color={store.paused ? "yellow" : undefined}
            onClick={() => store.togglePause()}
          >
            {store.paused ? "▶ resume" : "⏸ pause"}
          </Button>
          <Button
            size="compact-sm"
            variant="default"
            color="red"
            onClick={() => store.clear()}
            disabled={store.entries.length === 0}
          >
            clear
          </Button>
          <Divider orientation="vertical" />
          <TextInput
            size="xs"
            placeholder="search (command, pane id, event type…)"
            value={store.search}
            onChange={(e) => store.setSearch(e.currentTarget.value)}
            style={{ minWidth: 280 }}
          />
          <Divider orientation="vertical" />
          <DirectionChip store={store} dir="out" label={`↑ out ${counts.out}`} color="blue" />
          <DirectionChip
            store={store}
            dir="in-event"
            label={`↓ event ${counts["in-event"]}`}
            color="teal"
          />
          <DirectionChip
            store={store}
            dir="in-response"
            label={`↓ resp ${counts["in-response"]}`}
            color="grape"
          />
          <DirectionChip
            store={store}
            dir="in-error"
            label={`⚠ err ${counts["in-error"]}`}
            color="red"
          />
          <Divider orientation="vertical" />
          <Text size="xs" c="dimmed">
            {visible.length} / {store.entries.length} shown
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => store.clearFilters()}
            disabled={
              store.search === "" &&
              Object.keys(store.hiddenEventTypes).length === 0 &&
              !Object.values(store.hiddenDirections).some(Boolean)
            }
          >
            reset filters
          </Button>
        </Group>

        {/* Event-type chips — only meaningful when in-event is visible */}
        {store.knownEventTypes.length > 0 && !store.hiddenDirections["in-event"] && (
          <Group gap={4} wrap="wrap" mt={6}>
            <Text size="xs" c="dimmed">
              event types:
            </Text>
            {store.knownEventTypes.map((t) => {
              const hidden = store.hiddenEventTypes[t] === true;
              return (
                <Badge
                  key={t}
                  size="xs"
                  variant={hidden ? "outline" : "light"}
                  color={hidden ? "gray" : "teal"}
                  style={{ cursor: "pointer", opacity: hidden ? 0.45 : 1 }}
                  onClick={() => store.toggleEventType(t)}
                >
                  %{t}
                </Badge>
              );
            })}
          </Group>
        )}
      </Paper>

      {/* -------------------------- Split view -------------------------- */}
      <Group align="stretch" gap="xs" style={{ flex: 1, minHeight: 0 }}>
        {/* Timeline */}
        <Paper withBorder style={{ flex: 1.6, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <ScrollArea type="auto" style={{ flex: 1 }}>
            <table
              style={{
                width: "100%",
                fontSize: 11,
                fontFamily: "var(--mantine-font-family-monospace)",
                borderCollapse: "collapse",
              }}
            >
              <thead
                style={{
                  position: "sticky",
                  top: 0,
                  background: "var(--mantine-color-body)",
                  zIndex: 1,
                }}
              >
                <tr style={{ textAlign: "left", color: "var(--mantine-color-dimmed)" }}>
                  <th style={thStyle}>time</th>
                  <th style={thStyle}>Δ</th>
                  <th style={thStyle}>dir</th>
                  <th style={thStyle}>type</th>
                  <th style={thStyle}>summary</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>rtt</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry, i) => (
                  <TimelineRow
                    key={entry.id}
                    entry={entry}
                    prev={i > 0 ? visible[i - 1] : null}
                    selected={store.selectedId === entry.id}
                    onSelect={() => store.select(entry.id)}
                    paneLabels={paneLabels}
                  />
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: 12, color: "var(--mantine-color-dimmed)" }}>
                      {store.entries.length === 0
                        ? "No wire activity yet. Interact with a pane to generate traffic."
                        : "No entries match the current filter."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollArea>
        </Paper>

        {/* Detail panel */}
        <Paper withBorder p="sm" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <DetailPanel store={store} paneLabels={paneLabels} />
        </Paper>
      </Group>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Toolbar direction chip
// ---------------------------------------------------------------------------

interface ChipProps {
  readonly store: InspectorStore;
  readonly dir: WireEntry["dir"];
  readonly label: string;
  readonly color: string;
}

const DirectionChip = observer(function DirectionChip({
  store,
  dir,
  label,
  color,
}: ChipProps) {
  const hidden = store.hiddenDirections[dir];
  return (
    <Badge
      size="sm"
      variant={hidden ? "outline" : "filled"}
      color={hidden ? "gray" : color}
      style={{ cursor: "pointer", opacity: hidden ? 0.5 : 1, userSelect: "none" }}
      onClick={() => store.toggleDirection(dir)}
    >
      {label}
    </Badge>
  );
});

// ---------------------------------------------------------------------------
// Timeline row
// ---------------------------------------------------------------------------

interface RowProps {
  readonly entry: InspectorEntry;
  readonly prev: InspectorEntry | null;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly paneLabels: Map<number, string>;
}

const thStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "2px 8px",
  verticalAlign: "top",
  whiteSpace: "nowrap",
};

function TimelineRow({ entry, prev, selected, onSelect, paneLabels }: RowProps) {
  const delta = prev !== null ? entry.ts - prev.ts : 0;
  const presentation = presentFor(entry.wire, paneLabels);
  return (
    <tr
      onClick={onSelect}
      style={{
        cursor: "pointer",
        background: selected ? "var(--mantine-color-blue-light)" : undefined,
        borderBottom: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <td style={{ ...tdStyle, color: "var(--mantine-color-dimmed)" }}>
        {formatTs(entry.ts)}
      </td>
      <td style={{ ...tdStyle, color: "var(--mantine-color-dimmed)", textAlign: "right" }}>
        {prev !== null ? `+${formatMs(delta)}` : ""}
      </td>
      <td style={{ ...tdStyle, color: presentation.color }}>
        {presentation.arrow}
      </td>
      <td style={{ ...tdStyle, fontWeight: 600 }}>{presentation.type}</td>
      <td
        style={{
          ...tdStyle,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: 0,
          width: "100%",
        }}
        title={presentation.summary}
      >
        {presentation.summary}
      </td>
      <td style={{ ...tdStyle, textAlign: "right", color: "var(--mantine-color-dimmed)" }}>
        {entry.latencyMs !== null ? `${formatMs(entry.latencyMs)}` : ""}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

const DetailPanel = observer(function DetailPanel({
  store,
  paneLabels,
}: {
  store: InspectorStore;
  paneLabels: Map<number, string>;
}) {
  const entry = store.selectedEntry;
  if (entry === null) {
    return (
      <Text c="dimmed" size="sm">
        Select an entry on the left to inspect it.
      </Text>
    );
  }

  const p = presentFor(entry.wire, paneLabels);

  return (
    <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
      <Group gap="xs" justify="space-between">
        <Group gap="xs">
          <Badge color={badgeColor(entry.wire.dir)} variant="light">
            {p.arrow} {entry.wire.dir}
          </Badge>
          <Text fw={600}>{p.type}</Text>
        </Group>
        <Text size="xs" c="dimmed">
          {new Date(entry.ts).toLocaleTimeString()}.
          {String(entry.ts % 1000).padStart(3, "0")}
        </Text>
      </Group>

      {entry.wire.dir === "out" && entry.latencyMs !== null && (
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            round-trip:
          </Text>
          <Badge size="xs" color="grape" variant="light">
            {formatMs(entry.latencyMs)}
          </Badge>
          <Tooltip label="Jump to response">
            <ActionIcon
              size="xs"
              variant="subtle"
              onClick={() =>
                entry.responseEntryId !== null && store.select(entry.responseEntryId)
              }
            >
              →
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
      {entry.wire.dir === "in-response" && (
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            round-trip:
          </Text>
          <Badge
            size="xs"
            color={entry.wire.response.success ? "grape" : "red"}
            variant="light"
          >
            {formatMs(entry.wire.latencyMs)} — {entry.wire.response.success ? "ok" : "error"}
          </Badge>
        </Group>
      )}

      <Divider />
      <Text size="xs" c="dimmed" fw={600}>
        payload
      </Text>
      <ScrollArea style={{ flex: 1 }} type="auto">
        <Code
          block
          style={{
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {renderPayload(entry.wire)}
        </Code>
      </ScrollArea>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

interface Presentation {
  readonly arrow: string;
  readonly color: string;
  readonly type: string;
  readonly summary: string;
}

function presentFor(w: WireEntry, paneLabels: Map<number, string>): Presentation {
  if (w.dir === "out") {
    const msg = w.msg;
    if (msg.kind === "execute") {
      return {
        arrow: "↑",
        color: "var(--mantine-color-blue-6)",
        type: `execute #${msg.id}`,
        summary: msg.command,
      };
    }
    if (msg.kind === "sendKeys") {
      return {
        arrow: "↑",
        color: "var(--mantine-color-blue-6)",
        type: `sendKeys #${msg.id}`,
        summary: `${msg.target}  ${escapeForDisplay(msg.keys)}`,
      };
    }
    return {
      arrow: "↑",
      color: "var(--mantine-color-blue-6)",
      type: `detach #${msg.id}`,
      summary: "",
    };
  }
  if (w.dir === "in-event") {
    return {
      arrow: "↓",
      color: "var(--mantine-color-teal-6)",
      type: `%${w.event.type}`,
      summary: summarizeEvent(w.event, paneLabels),
    };
  }
  if (w.dir === "in-response") {
    const head = w.response.output[0] ?? "";
    const more = w.response.output.length > 1 ? ` …+${w.response.output.length - 1}` : "";
    return {
      arrow: "↓",
      color: "var(--mantine-color-grape-6)",
      type: `response #${w.id}${w.response.success ? "" : " !err"}`,
      summary: `${head}${more}`,
    };
  }
  return {
    arrow: "⚠",
    color: "var(--mantine-color-red-6)",
    type: `error${w.id !== null ? ` #${w.id}` : ""}`,
    summary: w.message,
  };
}

function badgeColor(dir: WireEntry["dir"]): string {
  if (dir === "out") return "blue";
  if (dir === "in-event") return "teal";
  if (dir === "in-response") return "grape";
  return "red";
}

function renderPayload(w: WireEntry): string {
  if (w.dir === "out") return JSON.stringify(w.msg, null, 2);
  if (w.dir === "in-event") {
    const ev = w.event;
    if (ev.type === "output" || ev.type === "extended-output") {
      // Decode base64 and show as escaped ASCII so the inspector can
      // serve as a raw-byte viewer.
      const ageNote =
        ev.type === "extended-output" ? `  age=${ev.age}ms` : "";
      return `paneId=%${ev.paneId}${ageNote}\nbytes=${prettyBase64(ev.dataBase64)}\n\n${JSON.stringify({ ...ev, dataBase64: `<${ev.dataBase64.length} base64 chars>` }, null, 2)}`;
    }
    return JSON.stringify(ev, null, 2);
  }
  if (w.dir === "in-response") {
    const req = w.request !== null ? JSON.stringify(w.request, null, 2) : "(request evicted from ring)";
    return `latency: ${formatMs(w.latencyMs)}\nsuccess: ${w.response.success}\n\n--- request ---\n${req}\n\n--- response ---\n${JSON.stringify(w.response, null, 2)}`;
  }
  return JSON.stringify({ id: w.id, message: w.message }, null, 2);
}

// ---------------------------------------------------------------------------
// Event summarization (shared shape with DebugPanel, duplicated here
// intentionally — the inspector's summary needs to stay on a single
// line, whereas the debug panel is more forgiving)
// ---------------------------------------------------------------------------

function paneLabel(id: number, labels: Map<number, string>): string {
  return labels.get(id) ?? `%${id}`;
}

function summarizeEvent(ev: SerializedTmuxMessage, labels: Map<number, string>): string {
  if (ev.type === "output") {
    return `${paneLabel(ev.paneId, labels)}  "${prettyBase64(ev.dataBase64, 64)}"`;
  }
  if (ev.type === "extended-output") {
    return `${paneLabel(ev.paneId, labels)} age=${ev.age}ms  "${prettyBase64(ev.dataBase64, 64)}"`;
  }
  if (ev.type === "pause" || ev.type === "continue" || ev.type === "pane-mode-changed") {
    return paneLabel(ev.paneId, labels);
  }
  if (ev.type === "window-pane-changed") {
    return `@${ev.windowId} → ${paneLabel(ev.paneId, labels)}`;
  }
  if (
    ev.type === "window-add" ||
    ev.type === "window-close" ||
    ev.type === "unlinked-window-add" ||
    ev.type === "unlinked-window-close"
  ) {
    return `@${ev.windowId}`;
  }
  if (ev.type === "window-renamed" || ev.type === "unlinked-window-renamed") {
    return `@${ev.windowId} → "${ev.name}"`;
  }
  if (ev.type === "layout-change") return `@${ev.windowId} layout=${ev.windowLayout}`;
  if (ev.type === "session-changed" || ev.type === "session-renamed") {
    return `$${ev.sessionId} "${ev.name}"`;
  }
  if (ev.type === "session-window-changed") return `$${ev.sessionId} → @${ev.windowId}`;
  if (ev.type === "client-session-changed") {
    return `${ev.clientName} → $${ev.sessionId} "${ev.name}"`;
  }
  if (ev.type === "client-detached") return ev.clientName;
  if (ev.type === "subscription-changed") {
    return `"${ev.name}" $${ev.sessionId}:@${ev.windowId}.${paneLabel(ev.paneId, labels)}`;
  }
  if (ev.type === "begin" || ev.type === "end" || ev.type === "error") {
    return `cmd #${ev.commandNumber}`;
  }
  if (ev.type === "exit") return ev.reason ?? "(clean)";
  if (ev.type === "message") return ev.message;
  if (ev.type === "config-error") return ev.error;
  if (ev.type === "paste-buffer-changed" || ev.type === "paste-buffer-deleted") return ev.name;
  return "";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function escapeForDisplay(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0x1b) out += "\\x1b";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else out += `\\x${c.toString(16).padStart(2, "0")}`;
  }
  return out;
}

function prettyBase64(b64: string, max: number = 96): string {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return `<invalid base64>`;
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
