// examples/web-multiplexer/web/components/SearchView.tsx
//
// Scrollback Search — full-text search across the history of every pane in
// every session at once. Type a substring; matching lines light up grouped by
// session › window › pane, live-updated as panes keep producing output. Click
// a hit to jump straight to that pane in multiplexer mode.
//
// This is pure projection: it reads `searchStore.results` (verified hits) and
// `demoStore.sessions` (to resolve a paneId to its location and label). No
// local search state — the store owns the corpus, index, and query.
//
// [LAW:dataflow-not-control-flow] Grouping runs the same reduce over the hit
//   list every render; "no results" is the empty-array case, not a branch that
//   skips the pipeline.

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
import type { SearchStore, SearchHit } from "../search-store.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly searchStore: SearchStore;
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

/** Hits for one pane, in arrival order. */
interface PaneGroup {
  readonly paneId: number;
  readonly location: PaneLocation | null;
  readonly hits: SearchHit[];
}

/** Chars of context kept on each side of the match before ellipsizing. */
const CTX_BEFORE = 48;
const CTX_AFTER = 160;

export const SearchView = observer(function SearchView({
  demoStore,
  searchStore,
  uiStore,
}: Props) {
  const locations = useMemo(
    () => buildPaneLocations(demoStore),
    // Recompute when the topology changes. `sessions` is the observable the
    // tree is rebuilt onto, so this memo refreshes as panes come and go.
    [demoStore.sessions],
  );

  const results = searchStore.results;
  const groups = groupByPane(results, locations);
  const hasQuery = searchStore.query.trim().length > 0;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Scrollback Search
          </Text>
          <TextInput
            size="xs"
            placeholder="search all pane history…"
            value={searchStore.query}
            onChange={(e) => searchStore.setQuery(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 220 }}
            autoFocus
          />
          <Switch
            size="xs"
            label="Aa"
            checked={searchStore.caseSensitive}
            onChange={() => searchStore.toggleCaseSensitive()}
            aria-label="case sensitive"
          />
          <Badge variant="light" color="gray">
            {searchStore.totalLines.toLocaleString()} lines /{" "}
            {searchStore.indexedPaneCount} panes
          </Badge>
          {hasQuery && (
            <Badge variant="light" color="teal">
              {results.length}
              {results.length >= 500 ? "+" : ""} hits
            </Badge>
          )}
          <Badge
            variant="light"
            color={searchStore.backfilled ? "green" : "yellow"}
          >
            {searchStore.backfilling
              ? "indexing history…"
              : searchStore.backfilled
                ? "history indexed"
                : "live only"}
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
          {!hasQuery ? (
            <Text c="dimmed" size="sm" p="sm">
              Type to search the scrollback of every pane at once. History is
              captured across all sessions on first use; live output then keeps
              the attached session current (tmux streams <code>%output</code>{" "}
              for the attached session).
            </Text>
          ) : groups.length === 0 ? (
            <Text c="dimmed" size="sm" p="sm">
              No matches in {searchStore.totalLines.toLocaleString()} indexed
              lines.
            </Text>
          ) : (
            <Stack gap="md" p="xs">
              {groups.map((g) => (
                <PaneGroupBlock
                  key={g.paneId}
                  group={g}
                  query={searchStore.query.trim()}
                  caseSensitive={searchStore.caseSensitive}
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
  query,
  caseSensitive,
  onJump,
}: {
  group: PaneGroup;
  query: string;
  caseSensitive: boolean;
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
          {group.hits.length}
        </Badge>
      </Group>
      <Stack gap={2}>
        {group.hits.map((h) => (
          <HitLine
            key={h.lineId}
            hit={h}
            query={query}
            caseSensitive={caseSensitive}
          />
        ))}
      </Stack>
    </Stack>
  );
});

const HitLine = observer(function HitLine({
  hit,
  query,
  caseSensitive,
}: {
  hit: SearchHit;
  query: string;
  caseSensitive: boolean;
}) {
  const { before, match, after, headEllipsis, tailEllipsis } =
    windowAroundMatch(hit.text, hit.matchStart, hit.matchLen);
  // Re-key on query/case so MobX treats a changed needle as a render input
  // even though the hit's own fields didn't change.
  void query;
  void caseSensitive;
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
        {match}
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
  hits: SearchHit[],
  locations: Map<number, PaneLocation>,
): PaneGroup[] {
  const order: number[] = [];
  const byPane = new Map<number, SearchHit[]>();
  for (const h of hits) {
    let arr = byPane.get(h.paneId);
    if (arr === undefined) {
      arr = [];
      byPane.set(h.paneId, arr);
      order.push(h.paneId);
    }
    arr.push(h);
  }
  return order.map((paneId) => ({
    paneId,
    location: locations.get(paneId) ?? null,
    hits: byPane.get(paneId) ?? [],
  }));
}

/**
 * Slice a window of context around the matched span so long lines stay
 * compact while keeping the match visible.
 */
function windowAroundMatch(
  text: string,
  matchStart: number,
  matchLen: number,
): {
  before: string;
  match: string;
  after: string;
  headEllipsis: boolean;
  tailEllipsis: boolean;
} {
  const start = Math.max(0, matchStart - CTX_BEFORE);
  const end = Math.min(text.length, matchStart + matchLen + CTX_AFTER);
  return {
    before: text.slice(start, matchStart),
    match: text.slice(matchStart, matchStart + matchLen),
    after: text.slice(matchStart + matchLen, end),
    headEllipsis: start > 0,
    tailEllipsis: end < text.length,
  };
}
