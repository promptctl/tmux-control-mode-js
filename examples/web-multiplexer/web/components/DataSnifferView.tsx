// examples/web-multiplexer/web/components/DataSnifferView.tsx
//
// Structured Data Sniffer — a live watch over EVERY pane in EVERY session that
// pulls JSON, CSV/TSV and table blocks out of the raw byte stream and renders
// each as a real table. Type nothing; structured data just surfaces as panes
// emit it. Click a block to expand its rendered grid; click the pane label to
// jump to that pane.
//
// THE HEADLINE: blocks arrive from panes in sessions the browser is NOT focused
// on, tapped via `pipe-pane` in the bridge process — and the sniffer sits
// *between* the user and the terminal, observing without disturbing it (a
// read-only pty tap injects nothing).
//
// This is pure projection: it reads `store.blocks` (live feed) and
// `demoStore.sessions` (to resolve a paneId to its location + label). No local
// detection state — the store owns the engine and the feed.
//
// [LAW:dataflow-not-control-flow] The feed maps the same render over every
//   block each pass; "nothing sniffed yet" is the empty-array case, not a
//   skipped branch. [LAW:types-are-the-program] every block carries a valid
//   `table`, so rendering never branches on "is this parseable".

import { useMemo } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  ScrollArea,
  Button,
  Table,
} from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type {
  DataSnifferStore,
  SniffedBlock,
  SniffFormat,
} from "../data-sniff-store.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly store: DataSnifferStore;
  readonly uiStore: UiStore;
}

/** Where a pane lives, resolved from the session tree for jump + labelling. */
interface PaneLocation {
  readonly sessionId: number;
  readonly sessionName: string;
  readonly windowId: number;
  readonly windowIndex: number;
  readonly windowName: string;
  readonly paneIndex: number;
}

const FORMAT_COLOR: Record<SniffFormat, string> = {
  json: "yellow",
  csv: "teal",
  tsv: "cyan",
  table: "grape",
};

/** Cells beyond this per row / rows beyond this are elided in the rendered grid. */
const MAX_RENDER_ROWS = 200;
const MAX_RENDER_COLS = 40;

export const DataSnifferView = observer(function DataSnifferView({
  demoStore,
  store,
  uiStore,
}: Props) {
  const locations = useMemo(
    () => buildPaneLocations(demoStore),
    [demoStore.sessions],
  );

  const blocks = store.blocks;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Structured Data Sniffer
          </Text>
          <Badge variant="light" color="gray">
            {store.sniffedPaneCount} panes tapped
          </Badge>
          <Badge variant="light" color="teal">
            {store.blockCount}
            {store.blockCount >= 500 ? "+" : ""} blocks
          </Badge>
          <Badge variant="light" color={store.active ? "green" : "yellow"}>
            {store.active ? "firehose live" : "firehose off"}
          </Badge>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => store.clearFeed()}
            disabled={store.blockCount === 0}
          >
            Clear
          </Button>
          <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
            click a block to render it · click the pane to jump
          </Text>
        </Group>
      </Paper>

      <Paper
        withBorder
        p="xs"
        style={{
          flex: 1,
          minHeight: 0,
          background: "var(--mantine-color-dark-9, #0b0d10)",
        }}
      >
        <ScrollArea style={{ height: "100%" }} type="auto">
          {blocks.length === 0 ? (
            <Text c="dimmed" size="sm" p="sm">
              Nothing structured yet — this is a live watch, so JSON, CSV/TSV and
              tables appear here as panes emit them. The sniffer reads every pane
              in every session via <code>pipe-pane</code> in the bridge process,
              so it surfaces data from panes this browser is <em>not</em> focused
              on, and it sits <em>between</em> you and the terminal without
              injecting a byte. Try <code>echo '[{"{"}a":1,"b":2{"}"}]'</code> or{" "}
              <code>ls -l</code> in any pane. ({store.sniffedPaneCount} panes
              tapped)
            </Text>
          ) : (
            <Stack gap="xs" p="xs">
              {[...blocks].reverse().map((b) => (
                <BlockRow
                  key={b.id}
                  block={b}
                  expanded={store.selectedId === b.id}
                  location={locations.get(b.paneId) ?? null}
                  onToggle={() => store.select(b.id)}
                  onJump={() => {
                    const loc = locations.get(b.paneId);
                    if (loc === undefined) return;
                    demoStore.jumpToPane(loc.sessionId, loc.windowId, b.paneId);
                    uiStore.setAppMode("multiplexer");
                  }}
                />
              ))}
            </Stack>
          )}
        </ScrollArea>
      </Paper>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// One block in the feed
// ---------------------------------------------------------------------------

const BlockRow = observer(function BlockRow({
  block,
  expanded,
  location,
  onToggle,
  onJump,
}: {
  block: SniffedBlock;
  expanded: boolean;
  location: PaneLocation | null;
  onToggle: () => void;
  onJump: () => void;
}) {
  const label =
    location !== null
      ? `${location.sessionName}:${location.windowIndex}.${location.paneIndex}`
      : `%${block.paneId}`;
  const dims = `${block.table.rows.length}×${columnCount(block)}`;
  const preview = firstLine(block.raw);

  return (
    <Paper withBorder p="xs" bg="dark.8">
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? "collapse block" : "expand block"}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--mantine-color-dimmed)",
            width: 16,
            padding: 0,
          }}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <Badge size="xs" color={FORMAT_COLOR[block.format]} variant="filled">
          {block.format}
        </Badge>
        <button
          type="button"
          onClick={onJump}
          disabled={location === null}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: location === null ? "default" : "pointer",
            color: "var(--mantine-color-teal-4)",
            fontFamily: "var(--mantine-font-family-monospace)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {label}
        </button>
        <Badge size="xs" variant="light" color="gray">
          {dims}
        </Badge>
        <Text
          size="xs"
          c="dimmed"
          truncate="end"
          style={{
            fontFamily: "var(--mantine-font-family-monospace)",
            flex: 1,
            minWidth: 0,
          }}
        >
          {preview}
        </Text>
      </Group>
      {expanded && (
        <ScrollArea type="auto" style={{ maxHeight: 360, marginTop: 8 }}>
          <RenderedTable block={block} />
        </ScrollArea>
      )}
    </Paper>
  );
});

const RenderedTable = observer(function RenderedTable({
  block,
}: {
  block: SniffedBlock;
}) {
  const { columns, rows } = block.table;
  const width = columnCount(block);
  const shownCols = Math.min(width, MAX_RENDER_COLS);
  const shownRows = rows.slice(0, MAX_RENDER_ROWS);
  const headerLabels =
    columns !== null
      ? columns
      : Array.from({ length: shownCols }, (_, i) => `${i + 1}`);

  return (
    <Stack gap={4}>
      <Table
        striped
        withTableBorder
        withColumnBorders
        stickyHeader
        styles={{
          td: {
            fontFamily: "var(--mantine-font-family-monospace)",
            fontSize: 12,
            whiteSpace: "pre",
          },
          th: { fontSize: 12 },
        }}
      >
        <Table.Thead>
          <Table.Tr>
            {headerLabels.slice(0, shownCols).map((c, i) => (
              <Table.Th key={i}>{c}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {shownRows.map((row, ri) => (
            <Table.Tr key={ri}>
              {Array.from({ length: shownCols }, (_, ci) => (
                <Table.Td key={ci}>{row[ci] ?? ""}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {(rows.length > MAX_RENDER_ROWS || width > MAX_RENDER_COLS) && (
        <Text size="xs" c="dimmed">
          {rows.length > MAX_RENDER_ROWS
            ? `showing first ${MAX_RENDER_ROWS} of ${rows.length} rows`
            : ""}
          {rows.length > MAX_RENDER_ROWS && width > MAX_RENDER_COLS ? " · " : ""}
          {width > MAX_RENDER_COLS
            ? `first ${MAX_RENDER_COLS} of ${width} columns`
            : ""}
        </Text>
      )}
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function columnCount(block: SniffedBlock): number {
  const { columns, rows } = block.table;
  if (columns !== null) return columns.length;
  return rows.reduce((max, r) => Math.max(max, r.length), 0);
}

function firstLine(raw: string): string {
  const nl = raw.indexOf("\n");
  const head = nl === -1 ? raw : raw.slice(0, nl);
  return head.length > 200 ? `${head.slice(0, 200)}…` : head;
}

function buildPaneLocations(demoStore: DemoStore): Map<number, PaneLocation> {
  const map = new Map<number, PaneLocation>();
  for (const s of demoStore.sessions) {
    for (const w of s.windows) {
      for (const p of w.panes) {
        map.set(p.id, {
          sessionId: s.id,
          sessionName: s.name,
          windowId: w.id,
          windowIndex: w.index,
          windowName: w.name,
          paneIndex: p.index,
        });
      }
    }
  }
  return map;
}
