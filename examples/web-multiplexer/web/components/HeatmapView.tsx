// examples/web-multiplexer/web/components/HeatmapView.tsx
//
// Pane activity heatmap — a live grid of every pane in every session
// in the tmux server, each cell glowing in proportion to its current
// output byte-rate. Click a cell to jump to that pane in multiplexer
// mode.
//
// This is pure projection: the component reads `demoStore.sessions`
// for structure and `heatmapStore.rates` for intensity. No local state.
//
// [LAW:dataflow-not-control-flow] The render loop runs over every
// pane unconditionally. Dark cells are encoded by data (intensity 0),
// not by branching on "is this pane active".

import { observer } from "mobx-react-lite";
import { Stack, Group, Paper, Text, Badge, Tooltip } from "@mantine/core";
import type { DemoStore, PaneInfo, SessionInfo } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type { HeatmapStore } from "../heatmap-store.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly heatmapStore: HeatmapStore;
  readonly uiStore: UiStore;
}

export const HeatmapView = observer(function HeatmapView({
  demoStore,
  heatmapStore,
  uiStore,
}: Props) {
  const sessions = demoStore.sessions;
  const totalPanes = sessions.reduce(
    (acc, s) => acc + s.windows.reduce((a, w) => a + w.panes.length, 0),
    0,
  );
  const activePanes = heatmapStore.rates.size;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Pane Activity Heatmap
          </Text>
          <Badge variant="light" color="gray">
            {totalPanes} panes / {sessions.length} sessions
          </Badge>
          <Badge variant="light" color="teal">
            {activePanes} active
          </Badge>
          <Badge variant="light" color="grape">
            peak {formatRate(heatmapStore.peakBps)}
          </Badge>
          <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
            click any cell to focus that pane
          </Text>
        </Group>
      </Paper>

      <Paper
        withBorder
        p="md"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          background: "var(--mantine-color-dark-9, #0b0d10)",
        }}
      >
        <Stack gap="lg">
          {sessions.map((s) => (
            <SessionBlock
              key={s.id}
              session={s}
              heatmapStore={heatmapStore}
              onPick={(p) => focusPane(demoStore, uiStore, s, p)}
            />
          ))}
          {sessions.length === 0 && (
            <Text c="dimmed" size="sm">
              Waiting for sessions…
            </Text>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Session block
// ---------------------------------------------------------------------------

const SessionBlock = observer(function SessionBlock({
  session,
  heatmapStore,
  onPick,
}: {
  session: SessionInfo;
  heatmapStore: HeatmapStore;
  onPick: (pane: PaneInfo) => void;
}) {
  const allPanes: Array<{ pane: PaneInfo; winIdx: number; winName: string }> = [];
  for (const w of session.windows) {
    for (const p of w.panes) {
      allPanes.push({ pane: p, winIdx: w.index, winName: w.name });
    }
  }

  // Session-level aggregate rate — a quick glance tells you which
  // sessions are noisy without scanning every cell.
  let sessionRate = 0;
  for (const { pane } of allPanes) sessionRate += heatmapStore.rateFor(pane.id);

  return (
    <Stack gap={4}>
      <Group gap="xs">
        <Text
          size="xs"
          fw={600}
          style={{ color: "var(--mantine-color-gray-3)" }}
        >
          {session.name}
        </Text>
        <Text size="xs" c="dimmed">
          {allPanes.length} panes
        </Text>
        {sessionRate > 0 && (
          <Text size="xs" c="dimmed">
            · {formatRate(sessionRate)}
          </Text>
        )}
      </Group>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
          gap: 6,
        }}
      >
        {allPanes.map(({ pane, winIdx, winName }) => (
          <PaneCell
            key={pane.id}
            session={session}
            pane={pane}
            winIdx={winIdx}
            winName={winName}
            heatmapStore={heatmapStore}
            onPick={onPick}
          />
        ))}
      </div>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Pane cell
// ---------------------------------------------------------------------------

const PaneCell = observer(function PaneCell({
  session,
  pane,
  winIdx,
  winName,
  heatmapStore,
  onPick,
}: {
  session: SessionInfo;
  pane: PaneInfo;
  winIdx: number;
  winName: string;
  heatmapStore: HeatmapStore;
  onPick: (pane: PaneInfo) => void;
}) {
  const intensity = heatmapStore.intensityFor(pane.id);
  const rate = heatmapStore.rateFor(pane.id);
  const bg = colorFor(intensity);
  const border = intensity > 0.02 ? "transparent" : "#1a1d22";

  const label = `${session.name}:${winIdx}.${pane.index}`;
  const tooltip =
    rate > 0
      ? `${label} — ${winName}\n${formatRate(rate)}  (${pane.width}×${pane.height})`
      : `${label} — ${winName}\nidle  (${pane.width}×${pane.height})`;

  return (
    <Tooltip label={tooltip} withArrow multiline>
      <button
        type="button"
        onClick={() => onPick(pane)}
        style={{
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: 4,
          padding: "6px 4px",
          cursor: "pointer",
          minHeight: 42,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "space-between",
          color: intensity > 0.55 ? "#0b0d10" : "#cfd5dc",
          fontFamily: "var(--mantine-font-family-monospace)",
          fontSize: 10,
          lineHeight: 1.1,
          boxShadow: intensity > 0.3 ? `0 0 ${Math.round(intensity * 14)}px ${bg}` : "none",
          transition: "background 180ms linear, box-shadow 180ms linear",
          outline: "none",
        }}
      >
        <span style={{ fontWeight: 600 }}>
          {winIdx}.{pane.index}
        </span>
        <span style={{ opacity: 0.75 }}>
          {rate > 0 ? formatRate(rate) : "idle"}
        </span>
      </button>
    </Tooltip>
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function focusPane(
  demoStore: DemoStore,
  uiStore: UiStore,
  session: SessionInfo,
  pane: PaneInfo,
): void {
  // Find which window this pane belongs to so we can navigate there.
  const window = session.windows.find((w) => w.panes.some((p) => p.id === pane.id));
  if (window === undefined) return;
  demoStore.selectSession(session.id);
  demoStore.selectWindow(window.id);
  demoStore.selectPane(pane);
  uiStore.setAppMode("multiplexer");
}

/**
 * Map 0..1 intensity to a color ramp. Dark neutral → teal → yellow →
 * hot orange. Chosen to look good on a dark background and to give
 * a clear visual ordering from idle to loud.
 */
function colorFor(t: number): string {
  if (t <= 0) return "#15181d";
  // Piecewise linear gradient through four stops.
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [21, 24, 29]], // near-black
    [0.15, [25, 74, 84]], // dim teal
    [0.45, [38, 166, 154]], // teal
    [0.75, [240, 200, 60]], // yellow
    [1.0, [255, 100, 50]], // hot orange
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a || 1);
      const r = Math.round(ca[0] + (cb[0] - ca[0]) * k);
      const g = Math.round(ca[1] + (cb[1] - ca[1]) * k);
      const bl = Math.round(ca[2] + (cb[2] - ca[2]) * k);
      return `rgb(${r}, ${g}, ${bl})`;
    }
  }
  return "rgb(255, 100, 50)";
}

function formatRate(bps: number): string {
  if (bps < 1) return "0 B/s";
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}
