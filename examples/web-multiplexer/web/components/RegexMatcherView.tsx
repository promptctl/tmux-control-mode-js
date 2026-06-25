// examples/web-multiplexer/web/components/RegexMatcherView.tsx
//
// Cross-terminal regex matcher — a live "tail -f | grep" across EVERY pane in
// EVERY session at once. Type a regex; matching lines stream in live, grouped
// by session › window › pane, the matched span highlighted. Click a hit to jump
// to that pane in multiplexer mode.
//
// THE HEADLINE: matches arrive from panes in sessions the browser is NOT
// focused on, because the bytes come from the bridge-process firehose
// (`pipe-pane` taps on every pane), not the attached `%output` channel.
//
// This is pure projection: it reads `store.matches` (live feed) and
// `demoStore.sessions` (to resolve a paneId to its location and label). No
// local match state — the store owns the engine, the feed, and the pattern.
//
// [LAW:dataflow-not-control-flow] Grouping runs the same reduce over the feed
//   every render; "no matches" is the empty-array case, not a skipped branch.

import { useMemo } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  TextInput,
  Switch,
  ScrollArea,
} from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type { RegexMatcherStore, RegexMatch } from "../regex-matcher-store.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly regexStore: RegexMatcherStore;
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

/** Matches for one pane, in arrival order. */
interface PaneGroup {
  readonly paneId: number;
  readonly location: PaneLocation | null;
  readonly matches: RegexMatch[];
}

/** Chars of context kept on each side of the match before ellipsizing. */
const CTX_BEFORE = 48;
const CTX_AFTER = 160;

export const RegexMatcherView = observer(function RegexMatcherView({
  demoStore,
  regexStore,
  uiStore,
}: Props) {
  const locations = useMemo(
    () => buildPaneLocations(demoStore),
    [demoStore.sessions],
  );

  const matches = regexStore.matches;
  const groups = groupByPane(matches, locations);
  const hasPattern = regexStore.pattern.length > 0;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Cross-Terminal Regex
          </Text>
          <TextInput
            size="xs"
            placeholder="live regex across every pane…  e.g. ERROR|WARN"
            value={regexStore.pattern}
            onChange={(e) => regexStore.setPattern(e.currentTarget.value)}
            error={regexStore.compileError ?? undefined}
            style={{ flex: 1, minWidth: 260 }}
            autoFocus
            styles={{
              input: { fontFamily: "var(--mantine-font-family-monospace)" },
            }}
          />
          <Switch
            size="xs"
            label="Aa"
            checked={!regexStore.caseInsensitive}
            onChange={() => regexStore.toggleCaseInsensitive()}
            aria-label="case sensitive"
          />
          <Badge variant="light" color="gray">
            {regexStore.tappedPaneCount} panes tapped
          </Badge>
          {hasPattern && regexStore.compileError === null && (
            <Badge variant="light" color="teal">
              {regexStore.matchCount}
              {regexStore.matchCount >= 2000 ? "+" : ""} matches
            </Badge>
          )}
          <Badge variant="light" color={regexStore.active ? "green" : "yellow"}>
            {regexStore.active ? "firehose live" : "firehose off"}
          </Badge>
          <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
            click a hit to jump to that pane
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
          {regexStore.compileError !== null ? (
            <Text c="red" size="sm" p="sm">
              Invalid regular expression: {regexStore.compileError}
            </Text>
          ) : !hasPattern ? (
            <Text c="dimmed" size="sm" p="sm">
              Type a regular expression to grep the live output of every pane in
              every session at once. Matches stream in here — including from
              panes in sessions this browser is <em>not</em> focused on, because
              the bytes are tapped via <code>pipe-pane</code> in the bridge
              process, not the single attached <code>%output</code> stream.
            </Text>
          ) : groups.length === 0 ? (
            <Text c="dimmed" size="sm" p="sm">
              No matches yet — this is a live tail, so matches appear as panes
              produce output. ({regexStore.tappedPaneCount} panes tapped)
            </Text>
          ) : (
            <Stack gap="md" p="xs">
              {groups.map((g) => (
                <PaneGroupBlock
                  key={g.paneId}
                  group={g}
                  onJump={() => {
                    if (g.location === null) return;
                    demoStore.jumpToPane(
                      g.location.sessionId,
                      g.location.windowId,
                      g.paneId,
                    );
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
// Pane group
// ---------------------------------------------------------------------------

const PaneGroupBlock = observer(function PaneGroupBlock({
  group,
  onJump,
}: {
  group: PaneGroup;
  onJump: () => void;
}) {
  const loc = group.location;
  const label =
    loc !== null
      ? `${loc.sessionName}:${loc.windowIndex}.${loc.paneIndex}`
      : `%${group.paneId}`;
  const sub =
    loc !== null ? loc.windowName : "pane no longer in the session tree";

  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <button
          type="button"
          onClick={onJump}
          disabled={loc === null}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: loc === null ? "default" : "pointer",
            color: "var(--mantine-color-teal-4)",
            fontFamily: "var(--mantine-font-family-monospace)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {label}
        </button>
        <Text size="xs" c="dimmed" truncate="end">
          {sub}
        </Text>
        <Badge size="xs" variant="light" color="gray">
          {group.matches.length}
        </Badge>
      </Group>
      <Stack gap={2}>
        {group.matches.map((m) => (
          <MatchLine key={m.id} match={m} />
        ))}
      </Stack>
    </Stack>
  );
});

const MatchLine = observer(function MatchLine({
  match,
}: {
  match: RegexMatch;
}) {
  const { before, hit, after, headEllipsis, tailEllipsis } = windowAroundMatch(
    match.text,
    match.matchStart,
    match.matchLen,
  );
  return (
    <Text
      size="xs"
      style={{
        fontFamily: "var(--mantine-font-family-monospace)",
        whiteSpace: "pre",
        overflow: "hidden",
        textOverflow: "ellipsis",
        color: "#cfd5dc",
      }}
    >
      {headEllipsis ? "… " : ""}
      {before}
      <mark
        style={{
          background: "var(--mantine-color-yellow-5)",
          color: "#0b0d10",
          borderRadius: 2,
        }}
      >
        {hit}
      </mark>
      {after}
      {tailEllipsis ? " …" : ""}
    </Text>
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
          windowName: w.name,
          paneIndex: p.index,
        });
      }
    }
  }
  return map;
}

function groupByPane(
  matches: readonly RegexMatch[],
  locations: Map<number, PaneLocation>,
): PaneGroup[] {
  const order: number[] = [];
  const byPane = new Map<number, RegexMatch[]>();
  for (const m of matches) {
    let arr = byPane.get(m.paneId);
    if (arr === undefined) {
      arr = [];
      byPane.set(m.paneId, arr);
      order.push(m.paneId);
    }
    arr.push(m);
  }
  return order.map((paneId) => ({
    paneId,
    location: locations.get(paneId) ?? null,
    matches: byPane.get(paneId) ?? [],
  }));
}

/**
 * Slice a window of context around the matched span so long lines stay compact
 * while keeping the match visible.
 */
function windowAroundMatch(
  text: string,
  matchStart: number,
  matchLen: number,
): {
  before: string;
  hit: string;
  after: string;
  headEllipsis: boolean;
  tailEllipsis: boolean;
} {
  const start = Math.max(0, matchStart - CTX_BEFORE);
  const end = Math.min(text.length, matchStart + matchLen + CTX_AFTER);
  return {
    before: text.slice(start, matchStart),
    hit: text.slice(matchStart, matchStart + matchLen),
    after: text.slice(matchStart + matchLen, end),
    headEllipsis: start > 0,
    tailEllipsis: end < text.length,
  };
}
