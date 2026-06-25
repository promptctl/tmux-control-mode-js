// examples/web-multiplexer/web/components/ScrollbackTimeMachineView.tsx
//
// Scrollback time machine — bidirectional scrub through a pane's WHOLE life. Hit
// Record: the store seeds every pane with a `capture-pane -e -p -S - -E -`
// snapshot (its full scrollback + screen, history that predates the recording),
// then captures the forward firehose. In review you drag ONE timeline: left of
// the "now" marker you scroll UP through captured scrollback rows; right of it
// you play FORWARD through recorded time. The terminal reconstructs every moment
// with full ANSI state.
//
// THE AXIS: the only demo that uses `capture-pane -e` to recover history the
// browser never attached to, and the only one that scrubs a single axis spanning
// pre-record scrollback AND post-record time. It closes the .5 gap (a forward-only
// replay can't show what was already on screen) by laying the seed down first.
//
// [LAW:dataflow-not-control-flow] The terminal's content is a pure function of
//   the scrub position: `resolveMoment` turns `pos` into a Moment, `momentBytes`
//   turns the Moment into paint-bytes. The only branch in the paint path is the
//   forward-delta OPTIMIZATION (write `bytesBetween` instead of reseeding) keyed
//   on the single `renderedMoment` record — same screen either way.
// [LAW:effects-at-boundaries] The view performs DOM writes; the store owns
//   capture + the clock; the engine computes the bytes. Three seams, no overlap.

import { useEffect, useMemo, useRef } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  Button,
  ActionIcon,
  Slider,
  Tooltip,
} from "@mantine/core";
import { XtermSink } from "@promptctl/pane-terminal/xterm-sink";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import {
  ScrollbackTimeMachineStore,
  PLAYBACK_RATES,
  type PlaybackRate,
} from "../scrollback-store.ts";
import { activityHistogram } from "../session-recording-engine.ts";
import { bytesBetween } from "../session-recording-engine.ts";
import {
  type Moment,
  type Timeline,
  resolveMoment,
  splitFraction,
  historyDepth,
  momentBytes,
} from "../scrollback-engine.ts";

const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

const SPARKLINE_BUCKETS = 120;
// Slider resolution — fine enough that dragging feels continuous in both regions.
const SCRUB_STEP = 0.0005;

const HISTORY_COLOR = "var(--mantine-color-orange-5)";
const LIVE_COLOR = "var(--mantine-color-blue-5)";

interface Props {
  readonly demoStore: DemoStore;
  readonly store: ScrollbackTimeMachineStore;
  readonly uiStore: UiStore;
}

export const ScrollbackTimeMachineView = observer(
  function ScrollbackTimeMachineView({ demoStore, store, uiStore }: Props) {
    const ready = demoStore.connState === "ready";
    const timeline = store.timeline;

    return (
      <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
        <Paper withBorder p="xs">
          <Group gap="md" wrap="wrap">
            <Text fw={600} size="sm">
              Scrollback Time Machine
            </Text>
            <Text size="xs" c="dimmed">
              capture-pane seeds history → scrub backward into scrollback AND
              forward through recorded time
            </Text>
            <PhaseBadge store={store} ready={ready} />
            <RecordControls store={store} ready={ready} />
            {store.limitHit && (
              <Text size="xs" c="orange">
                recording hit the size cap and auto-stopped
              </Text>
            )}
            {store.seedTruncated && (
              <Text size="xs" c="orange">
                only the first panes were seeded (too many open)
              </Text>
            )}
          </Group>
        </Paper>

        {store.phase === "review" && <PaneSelector store={store} />}

        <Paper
          withBorder
          p="xs"
          style={{
            flex: 1,
            // Floor the surface so a short viewport never collapses the column.
            minHeight: 240,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <ReplayArea
            store={store}
            ready={ready}
            timeline={timeline}
            fontSize={uiStore.terminalFontSize}
          />
        </Paper>

        {store.phase === "review" && timeline !== null && (
          <TransportBar store={store} timeline={timeline} />
        )}
      </Stack>
    );
  },
);

// ---------------------------------------------------------------------------
// Phase badge + record controls
// ---------------------------------------------------------------------------

const PhaseBadge = observer(function PhaseBadge({
  store,
  ready,
}: {
  store: ScrollbackTimeMachineStore;
  ready: boolean;
}) {
  if (!ready)
    return (
      <Badge variant="light" color="yellow">
        bridge connecting
      </Badge>
    );
  if (store.seeding)
    return (
      <Badge variant="light" color="grape">
        capturing scrollback…
      </Badge>
    );
  const map: Record<
    ScrollbackTimeMachineStore["phase"],
    { color: string; label: string }
  > = {
    idle: { color: "gray", label: "ready to record" },
    recording: { color: "red", label: "● recording" },
    review: { color: "green", label: "review" },
  };
  const s = map[store.phase];
  return (
    <Badge
      variant={store.phase === "recording" ? "filled" : "light"}
      color={s.color}
    >
      {s.label}
    </Badge>
  );
});

const RecordControls = observer(function RecordControls({
  store,
  ready,
}: {
  store: ScrollbackTimeMachineStore;
  ready: boolean;
}) {
  if (store.phase === "recording")
    return (
      <Group gap="xs">
        <Button size="xs" color="red" onClick={() => store.stopRecording()}>
          Stop ⏹
        </Button>
        <Badge variant="light" color="gray">
          {formatTime(store.liveDurationMs)}
        </Badge>
      </Group>
    );
  return (
    <Group gap="xs">
      <Button
        size="xs"
        color="red"
        disabled={!ready || store.seeding}
        onClick={() => store.startRecording()}
      >
        Record ●
      </Button>
      {store.phase === "review" && (
        <Button size="xs" variant="default" onClick={() => store.reset()}>
          New recording
        </Button>
      )}
    </Group>
  );
});

// ---------------------------------------------------------------------------
// Pane selector
// ---------------------------------------------------------------------------

const PaneSelector = observer(function PaneSelector({
  store,
}: {
  store: ScrollbackTimeMachineStore;
}) {
  const panes = [...store.snapshots.values()];
  if (panes.length === 0)
    return (
      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          No panes were seeded — nothing to scrub.
        </Text>
      </Paper>
    );
  return (
    <Paper withBorder p="xs">
      <Group gap="xs" wrap="wrap">
        <Text size="xs" c="dimmed">
          pane:
        </Text>
        {panes.map((snap) => {
          const depth = historyDepth(snap);
          return (
            <Button
              key={snap.paneId}
              size="compact-xs"
              variant={
                snap.paneId === store.selectedPaneId ? "filled" : "light"
              }
              onClick={() => store.selectPane(snap.paneId)}
            >
              %{snap.paneId} · {depth} hist rows
            </Button>
          );
        })}
      </Group>
    </Paper>
  );
});

// ---------------------------------------------------------------------------
// Replay area — the scrub-driven terminal
// ---------------------------------------------------------------------------

const ReplayArea = observer(function ReplayArea({
  store,
  ready,
  timeline,
  fontSize,
}: {
  store: ScrollbackTimeMachineStore;
  ready: boolean;
  timeline: Timeline | null;
  fontSize: number;
}) {
  if (!ready) return <Centered>Connecting to bridge…</Centered>;
  if (store.seeding)
    return <Centered>Capturing every pane's scrollback…</Centered>;
  if (store.phase === "idle")
    return (
      <Centered>
        Hit <b>&nbsp;Record&nbsp;</b> — every pane's scrollback is captured up
        front, then the live stream is recorded. Scrub back into history,
        forward through time.
      </Centered>
    );
  if (store.phase === "recording")
    return (
      <Centered>
        ● Recording {formatTime(store.liveDurationMs)} — produce output in any
        pane, then hit Stop to scrub it.
      </Centered>
    );
  if (timeline === null) return <Centered>No seeded pane to scrub.</Centered>;
  const { snapshot } = timeline;
  return (
    <ReplaySurface
      // Fresh, cleared sink per pane and per recording.
      key={`${timeline.paneId}:${snapshot.lines.length}:${timeline.durationMs}`}
      timeline={timeline}
      pos={store.pos}
      cols={snapshot.geometry.cols}
      rows={snapshot.geometry.rows}
      fontSize={fontSize}
    />
  );
});

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "0 var(--mantine-spacing-md)",
      }}
    >
      <Text c="dimmed" size="sm">
        {children}
      </Text>
    </div>
  );
}

/**
 * Owns an `XtermSink` and paints it to match the scrub position. Forward steps
 * inside the live region write only the byte delta (`bytesBetween`); any other
 * move — into scrollback, a rewind, or crossing the now-boundary — clears and
 * repaints from `momentBytes`. `renderedMoment` is the single record of what the
 * terminal currently shows, so the delta math reads and updates only it.
 *
 * [LAW:no-ambient-temporal-coupling] one owner for the sink lifecycle (this
 *   component), one owner for "what is painted" (the scrub effect on `pos`).
 */
function ReplaySurface({
  timeline,
  pos,
  cols,
  rows,
  fontSize,
}: {
  timeline: Timeline;
  pos: number;
  cols: number;
  rows: number;
  fontSize: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<XtermSink | null>(null);
  const rendered = useRef<Moment | null>(null);
  const initial = useRef({ cols, rows, fontSize });

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const sink = new XtermSink({
      container,
      fontFamily: FONT_FAMILY,
      fontSize: initial.current.fontSize,
    });
    sinkRef.current = sink;
    // First resize drains the buffer and unblocks painting (see the .4/.5 findings).
    sink.resize(initial.current.cols, initial.current.rows);
    rendered.current = null;
    return () => {
      sink.dispose();
      sinkRef.current = null;
    };
  }, []);

  useEffect(() => {
    const sink = sinkRef.current;
    if (sink === null) return;
    const moment = resolveMoment(pos, timeline);
    const prev = rendered.current;
    if (
      moment.kind === "live" &&
      prev !== null &&
      prev.kind === "live" &&
      moment.tMs >= prev.tMs
    ) {
      sink.write(
        bytesBetween(timeline.recording, timeline.paneId, prev.tMs, moment.tMs),
      );
    } else {
      sink.clear();
      sink.write(momentBytes(moment, timeline));
    }
    rendered.current = moment;
  }, [pos, timeline]);

  useEffect(() => {
    sinkRef.current?.setFontSize(fontSize);
  }, [fontSize]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        background: "var(--mantine-color-dark-9, #0b0d10)",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Transport bar — play/pause, rate, unified history→time scrubber
// ---------------------------------------------------------------------------

const TransportBar = observer(function TransportBar({
  store,
  timeline,
}: {
  store: ScrollbackTimeMachineStore;
  timeline: Timeline;
}) {
  const split = splitFraction(timeline);
  const histogram = useMemo(
    () =>
      activityHistogram(timeline.recording, timeline.paneId, SPARKLINE_BUCKETS),
    [timeline],
  );
  const moment = resolveMoment(store.pos, timeline);

  return (
    <Paper withBorder p="xs">
      <Group gap="sm" wrap="nowrap" align="center">
        <Tooltip label={store.playing ? "Pause" : "Play"}>
          <ActionIcon
            variant="filled"
            size="lg"
            disabled={timeline.durationMs <= 0}
            onClick={() => store.togglePlay()}
            aria-label={store.playing ? "pause" : "play"}
          >
            {store.playing ? "⏸" : "▶"}
          </ActionIcon>
        </Tooltip>

        <Group gap={2} wrap="nowrap">
          {PLAYBACK_RATES.map((r) => (
            <Button
              key={r}
              size="compact-xs"
              variant={r === store.rate ? "filled" : "light"}
              disabled={timeline.durationMs <= 0}
              onClick={() => store.setRate(r as PlaybackRate)}
            >
              {r}×
            </Button>
          ))}
        </Group>

        <div style={{ flex: 1, minWidth: 0 }}>
          <RegionBar split={split} histogram={histogram} />
          <Slider
            min={0}
            max={1}
            value={store.pos}
            onChange={(v) => store.seek(v)}
            label={null}
            step={SCRUB_STEP}
            size="sm"
            marks={
              split > 0 && split < 1
                ? [{ value: split, label: "now" }]
                : undefined
            }
          />
        </div>

        <Text
          size="xs"
          c="dimmed"
          style={{
            fontFamily: "var(--mantine-font-family-monospace)",
            whiteSpace: "nowrap",
            minWidth: 132,
            textAlign: "right",
          }}
        >
          {momentLabel(moment, timeline)}
        </Text>
      </Group>
    </Paper>
  );
});

/**
 * The two-zone backdrop for the scrubber: an orange history band on the left, a
 * blue live band (with the activity sparkline) on the right, split at the
 * now-boundary. Makes the bidirectional axis legible at a glance.
 */
function RegionBar({
  split,
  histogram,
}: {
  split: number;
  histogram: readonly number[];
}) {
  const max = histogram.reduce((m, v) => Math.max(m, v), 0);
  return (
    <div style={{ display: "flex", height: 24, marginBottom: 2, gap: 1 }}>
      {split > 0 && (
        <div
          style={{
            flex: split,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: HISTORY_COLOR,
            opacity: 0.18,
            borderRadius: 1,
            fontSize: 9,
            color: "var(--mantine-color-orange-3)",
            overflow: "hidden",
          }}
        >
          ⟵ scrollback
        </div>
      )}
      {split < 1 && (
        <div
          style={{
            flex: 1 - split,
            display: "flex",
            alignItems: "flex-end",
            gap: 1,
            borderRadius: 1,
            overflow: "hidden",
          }}
        >
          {histogram.map((v, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${max === 0 ? 0 : Math.max(2, (v / max) * 100)}%`,
                background: LIVE_COLOR,
                opacity: v === 0 ? 0.15 : 0.7,
                borderRadius: 1,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Human label for where the scrub head sits on the unified axis. */
function momentLabel(moment: Moment, tl: Timeline): string {
  if (moment.kind === "history") {
    const back = historyDepth(tl.snapshot) - moment.topLine;
    return back <= 0 ? "now (t=0)" : `⟵ −${back} rows`;
  }
  return `▶ +${formatTime(moment.tMs)} / ${formatTime(tl.durationMs)}`;
}

/** `m:ss.t` — minutes:seconds.tenths. */
function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  const tenths = Math.floor((ms % 1000) / 100);
  return `${min}:${sec.toString().padStart(2, "0")}.${tenths}`;
}
