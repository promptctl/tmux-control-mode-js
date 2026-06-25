// examples/web-multiplexer/web/components/SessionRecorderView.tsx
//
// Record / replay with scrubbing — the "DVR for your terminals" demo. Hit
// Record, let any pane in any session produce output, hit Stop, then scrub the
// captured byte stream like video: drag the timeline, play at 0.5–4×, watch the
// terminal reconstruct exactly what was on screen at that moment.
//
// THE AXIS: this is the only demo that captures the firehose WITH TIMING and
// reconstructs terminal STATE at an arbitrary past moment. The replay surface is
// not a live pane — it is an `XtermSink` this view OWNS and feeds recorded bytes
// to. So the .4 live-pane findings (select-window, the resize-on-subscribe race)
// don't apply; only "give the sink its first resize before writing" and "floor
// the container height" carry over.
//
// [LAW:dataflow-not-control-flow] The terminal's content is a pure function of
//   the scrub position: forward steps write the byte delta (`bytesBetween`), a
//   backward jump clears and re-seeks (`bytesUpTo`). There is no "playing vs
//   paused" branch in the render path — the store's clock just moves `scrubMs`
//   and the surface reacts.
// [LAW:effects-at-boundaries] The view performs the DOM writes; the store owns
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
  SessionRecorderStore,
  PLAYBACK_RATES,
  type PlaybackRate,
} from "../session-recorder-store.ts";
import {
  bytesUpTo,
  bytesBetween,
  activityHistogram,
  type Recording,
} from "../session-recording-engine.ts";

// Mirrors PaneView / the playground: the xterm fontFamily for the replay sink.
const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

// Replay geometry when a pane's size was never captured (it vanished before the
// query resolved). A sane default; faithful replay uses the pane's real size.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const SPARKLINE_BUCKETS = 120;

interface Props {
  readonly demoStore: DemoStore;
  readonly store: SessionRecorderStore;
  readonly uiStore: UiStore;
}

export const SessionRecorderView = observer(function SessionRecorderView({
  demoStore,
  store,
  uiStore,
}: Props) {
  const ready = demoStore.connState === "ready";
  const recording = store.recording;
  const selectedPane =
    store.selectedPaneId === null
      ? null
      : (recording.panes.find((p) => p.paneId === store.selectedPaneId) ?? null);

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Session Recorder
          </Text>
          <Text size="xs" c="dimmed">
            capture the firehose with timing → scrub the byte stream like video
          </Text>
          <PhaseBadge store={store} ready={ready} />
          <RecordControls store={store} ready={ready} />
          {store.limitHit && (
            <Text size="xs" c="orange">
              recording hit the size cap and auto-stopped
            </Text>
          )}
        </Group>
      </Paper>

      {store.phase === "review" && (
        <PaneSelector store={store} recording={recording} />
      )}

      <Paper
        withBorder
        p="xs"
        style={{
          flex: 1,
          // Floor the surface so a short viewport never collapses the terminal
          // column to zero height (xterm suspends rendering when clipped).
          minHeight: 240,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ReplayArea
          store={store}
          recording={recording}
          paneId={store.selectedPaneId}
          cols={selectedPane?.geometry?.cols ?? DEFAULT_COLS}
          rows={selectedPane?.geometry?.rows ?? DEFAULT_ROWS}
          ready={ready}
          fontSize={uiStore.terminalFontSize}
        />
      </Paper>

      {store.phase === "review" && recording.durationMs > 0 && (
        <TransportBar store={store} recording={recording} />
      )}
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Phase badge + record controls
// ---------------------------------------------------------------------------

const PhaseBadge = observer(function PhaseBadge({
  store,
  ready,
}: {
  store: SessionRecorderStore;
  ready: boolean;
}) {
  if (!ready)
    return (
      <Badge variant="light" color="yellow">
        bridge connecting
      </Badge>
    );
  const map: Record<
    SessionRecorderStore["phase"],
    { color: string; label: string }
  > = {
    idle: { color: "gray", label: "ready to record" },
    recording: { color: "red", label: "● recording" },
    review: { color: "green", label: "review" },
  };
  const s = map[store.phase];
  return (
    <Badge variant={store.phase === "recording" ? "filled" : "light"} color={s.color}>
      {s.label}
    </Badge>
  );
});

const RecordControls = observer(function RecordControls({
  store,
  ready,
}: {
  store: SessionRecorderStore;
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
        disabled={!ready}
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
  recording,
}: {
  store: SessionRecorderStore;
  recording: Recording;
}) {
  if (recording.panes.length === 0)
    return (
      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          No bytes were captured — nothing produced output during the recording.
        </Text>
      </Paper>
    );
  return (
    <Paper withBorder p="xs">
      <Group gap="xs" wrap="wrap">
        <Text size="xs" c="dimmed">
          replay pane:
        </Text>
        {recording.panes.map((p) => (
          <Button
            key={p.paneId}
            size="compact-xs"
            variant={p.paneId === store.selectedPaneId ? "filled" : "light"}
            onClick={() => store.selectPane(p.paneId)}
          >
            %{p.paneId} · {formatBytes(p.byteCount)}
          </Button>
        ))}
      </Group>
    </Paper>
  );
});

// ---------------------------------------------------------------------------
// Replay area — the scrub-driven terminal
// ---------------------------------------------------------------------------

const ReplayArea = observer(function ReplayArea({
  store,
  recording,
  paneId,
  cols,
  rows,
  ready,
  fontSize,
}: {
  store: SessionRecorderStore;
  recording: Recording;
  paneId: number | null;
  cols: number;
  rows: number;
  ready: boolean;
  fontSize: number;
}) {
  if (!ready)
    return <Centered>Connecting to bridge…</Centered>;
  if (store.phase === "idle")
    return (
      <Centered>
        Hit <b>&nbsp;Record&nbsp;</b> then make any terminal produce output —
        the recorder captures every pane in every session.
      </Centered>
    );
  if (store.phase === "recording")
    return (
      <Centered>
        ● Recording {formatTime(store.liveDurationMs)} — produce output in any
        pane, then hit Stop to scrub it.
      </Centered>
    );
  if (paneId === null || recording.durationMs <= 0)
    return <Centered>No replayable bytes were captured.</Centered>;
  return (
    <ReplaySurface
      // Remount on a pane change so the new pane gets a fresh, cleared sink.
      key={paneId}
      recording={recording}
      paneId={paneId}
      scrubMs={store.scrubMs}
      cols={cols}
      rows={rows}
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
 * Owns an `XtermSink` and feeds it recorded bytes as the scrub position moves.
 * Forward steps write the delta (`bytesBetween`); a backward jump clears and
 * re-seeks (`bytesUpTo`). The sink is given its first `resize` directly from the
 * captured geometry — the same first-paint unlock the playground needed, here
 * for a sink we drive ourselves rather than one fed by a live PaneStream.
 *
 * [LAW:no-ambient-temporal-coupling] One owner for the sink lifecycle (this
 *   component) and one owner for "what is painted" (the scrub effect, keyed on
 *   `scrubMs`). `renderedMs` is the single record of how far the terminal has
 *   been advanced; the delta math reads and updates only it.
 */
function ReplaySurface({
  recording,
  paneId,
  scrubMs,
  cols,
  rows,
  fontSize,
}: {
  recording: Recording;
  paneId: number;
  scrubMs: number;
  cols: number;
  rows: number;
  fontSize: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<XtermSink | null>(null);
  const renderedMs = useRef(-1);
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
    // First resize drains the buffer and unblocks painting — without it the
    // sink holds every write forever (see the .4 findings).
    sink.resize(initial.current.cols, initial.current.rows);
    renderedMs.current = -1;
    return () => {
      sink.dispose();
      sinkRef.current = null;
    };
  }, []);

  // Paint the terminal to match `scrubMs`. The common forward case writes only
  // the new bytes; a rewind re-seeks from a cleared screen.
  useEffect(() => {
    const sink = sinkRef.current;
    if (sink === null) return;
    if (scrubMs < renderedMs.current) {
      sink.clear();
      sink.write(bytesUpTo(recording, paneId, scrubMs));
    } else {
      sink.write(bytesBetween(recording, paneId, renderedMs.current, scrubMs));
    }
    renderedMs.current = scrubMs;
  }, [scrubMs, recording, paneId]);

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
// Transport bar — play/pause, rate, scrubber with activity sparkline
// ---------------------------------------------------------------------------

const TransportBar = observer(function TransportBar({
  store,
  recording,
}: {
  store: SessionRecorderStore;
  recording: Recording;
}) {
  const paneId = store.selectedPaneId;
  // The sparkline is a function of the recording + pane only, not the playhead —
  // memoize so it doesn't recompute on every scrub tick.
  const histogram = useMemo(
    () =>
      paneId === null
        ? []
        : activityHistogram(recording, paneId, SPARKLINE_BUCKETS),
    [recording, paneId],
  );

  return (
    <Paper withBorder p="xs">
      <Group gap="sm" wrap="nowrap" align="center">
        <Tooltip label={store.playing ? "Pause" : "Play"}>
          <ActionIcon
            variant="filled"
            size="lg"
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
              onClick={() => store.setRate(r as PlaybackRate)}
            >
              {r}×
            </Button>
          ))}
        </Group>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Sparkline histogram={histogram} />
          <Slider
            min={0}
            max={recording.durationMs}
            value={store.scrubMs}
            onChange={(v) => store.seek(v)}
            label={(v) => formatTime(v)}
            step={1}
            size="sm"
          />
        </div>

        <Text
          size="xs"
          c="dimmed"
          style={{
            fontFamily: "var(--mantine-font-family-monospace)",
            whiteSpace: "nowrap",
          }}
        >
          {formatTime(store.scrubMs)} / {formatTime(recording.durationMs)}
        </Text>
      </Group>
    </Paper>
  );
});

/** A bytes-per-bin bar strip showing where the action is in the recording. */
function Sparkline({ histogram }: { histogram: readonly number[] }) {
  const max = histogram.reduce((m, v) => Math.max(m, v), 0);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 1,
        height: 24,
        marginBottom: 2,
      }}
    >
      {histogram.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${max === 0 ? 0 : Math.max(2, (v / max) * 100)}%`,
            background: "var(--mantine-color-blue-5)",
            opacity: v === 0 ? 0.15 : 0.7,
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `m:ss.t` — minutes:seconds.tenths, the scrub-friendly format. */
function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  const tenths = Math.floor((ms % 1000) / 100);
  return `${min}:${sec.toString().padStart(2, "0")}.${tenths}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
