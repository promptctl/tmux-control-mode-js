// examples/web-multiplexer/web/components/ReaderView.tsx
//
// Terminal Reader — point at any pane and read its output as clean, reflowed
// prose: ANSI styling and control noise stripped, terminal-width hard-wrapping
// undone, the text re-wrapped to a page width you choose with a slider. Useful
// for reading a long log or a man page that scrolled past, without the cramped
// grid. Tap a pane in the picker; drag the width slider and watch it re-flow.
//
// THE HEADLINE: the prose comes from panes in sessions the browser is NOT
// focused on, tapped via `pipe-pane` in the bridge process — reader mode sits
// *between* the user and the terminal, observing without injecting a byte.
//
// Pure projection: it reads `store.segments` (reflowed text), `store.activePaneId`
// and `demoStore.sessions` (to resolve a paneId to its label). No local parsing
// state — the store owns the engine; the wrap is a pure derivation of width.
//
// [LAW:dataflow-not-control-flow] The reader maps the same render over every
//   segment each pass; "nothing read yet" is the empty-array case, not a
//   skipped branch. [LAW:types-are-the-program] every segment is `text` or
//   `break`, so rendering never branches on "is this line empty".

import { useMemo } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  Button,
  ScrollArea,
  Slider,
} from "@mantine/core";
import type { DemoStore } from "../store.ts";
import {
  type ReaderStore,
  type ReaderSegment,
  MIN_WIDTH,
  MAX_WIDTH,
} from "../reader-store.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly store: ReaderStore;
}

/** Where a pane lives, resolved from the session tree for labelling + jump. */
interface PaneLocation {
  readonly sessionId: number;
  readonly sessionName: string;
  readonly windowId: number;
  readonly windowIndex: number;
  readonly paneIndex: number;
}

/** Cap on segments rendered into the DOM (the tail is what you read live). */
const MAX_RENDER_SEGMENTS = 4000;

export const ReaderView = observer(function ReaderView({
  demoStore,
  store,
}: Props) {
  const locations = useMemo(
    () => buildPaneLocations(demoStore),
    [demoStore.sessions],
  );

  const segments = store.segments;
  const activeId = store.activePaneId;
  const shown =
    segments.length > MAX_RENDER_SEGMENTS
      ? segments.slice(segments.length - MAX_RENDER_SEGMENTS)
      : segments;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Terminal Reader
          </Text>
          <Badge variant="light" color="gray">
            {store.tappedPaneCount} panes tapped
          </Badge>
          <Badge variant="light" color="teal">
            {store.activeLineCount} lines
          </Badge>
          <Badge variant="light" color={store.active ? "green" : "yellow"}>
            {store.active ? "firehose live" : "firehose off"}
          </Badge>
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 220 }}>
            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              page width: {store.width}
            </Text>
            <Slider
              size="xs"
              style={{ flex: 1 }}
              min={MIN_WIDTH}
              max={MAX_WIDTH}
              step={1}
              value={store.width}
              onChange={(v) => store.setWidth(v)}
              label={(v) => `${v} cols`}
              aria-label="page width in columns"
            />
          </Group>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => store.clearText()}
            disabled={store.tappedPaneCount === 0}
          >
            Clear
          </Button>
          <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
            tap a pane to read · drag width to reflow
          </Text>
        </Group>
      </Paper>

      <PanePicker
        paneIds={store.tappedPaneIds}
        activeId={activeId}
        locations={locations}
        onPick={(id) => store.selectPane(id)}
      />

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
          {activeId === null ? (
            <Text c="dimmed" size="sm" p="sm">
              Nothing to read yet — this is a live watch, so a pane's output
              appears here as it prints (no backfill of pre-existing scrollback).
              Reader mode reads every pane in every session via{" "}
              <code>pipe-pane</code> in the bridge process, so it surfaces output
              from panes this browser is <em>not</em> focused on, and it sits{" "}
              <em>between</em> you and the terminal without injecting a byte. Run{" "}
              <code>man bash</code> or <code>cat</code> a long log in any pane,
              then tap it above.
            </Text>
          ) : (
            <div
              style={{
                maxWidth: `${store.width + 4}ch`,
                margin: "0 auto",
                padding: "8px 4px",
                fontFamily: "var(--mantine-font-family-monospace)",
                fontSize: 13,
                lineHeight: 1.7,
              }}
            >
              {segments.length > MAX_RENDER_SEGMENTS && (
                <Text size="xs" c="dimmed" mb={6}>
                  showing last {MAX_RENDER_SEGMENTS} of {segments.length} lines
                </Text>
              )}
              {shown.map((seg) => (
                <SegmentRow key={seg.id} seg={seg} />
              ))}
            </div>
          )}
        </ScrollArea>
      </Paper>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// One reflowed segment
// ---------------------------------------------------------------------------

function SegmentRow({ seg }: { seg: ReaderSegment }) {
  if (seg.kind === "break") {
    return <div style={{ height: "0.9em" }} aria-hidden />;
  }
  return (
    <div
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        // A soft-wrapped tail is hinted with a faint hanging marker so the eye
        // knows it continues the line above, not a new logical line.
        color: seg.continuation
          ? "var(--mantine-color-dimmed)"
          : "var(--mantine-color-gray-3, #c9c9c9)",
        borderLeft: seg.continuation
          ? "2px solid var(--mantine-color-dark-4, #2c2e33)"
          : "2px solid transparent",
        paddingLeft: 8,
      }}
    >
      {seg.text === "" ? " " : seg.text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pane picker
// ---------------------------------------------------------------------------

const PanePicker = observer(function PanePicker({
  paneIds,
  activeId,
  locations,
  onPick,
}: {
  paneIds: readonly number[];
  activeId: number | null;
  locations: Map<number, PaneLocation>;
  onPick: (id: number) => void;
}) {
  if (paneIds.length === 0) return null;
  return (
    <Paper withBorder p="xs">
      <Group gap="xs" wrap="wrap">
        <Text size="xs" c="dimmed">
          reading:
        </Text>
        {paneIds.map((id) => {
          const loc = locations.get(id);
          const label =
            loc !== undefined
              ? `${loc.sessionName}:${loc.windowIndex}.${loc.paneIndex}`
              : `%${id}`;
          const active = id === activeId;
          return (
            <Button
              key={id}
              size="compact-xs"
              variant={active ? "filled" : "default"}
              color={active ? "teal" : "gray"}
              onClick={() => onPick(id)}
              styles={{
                label: { fontFamily: "var(--mantine-font-family-monospace)" },
              }}
            >
              {label}
            </Button>
          );
        })}
      </Group>
    </Paper>
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
          paneIndex: p.index,
        });
      }
    }
  }
  return map;
}
