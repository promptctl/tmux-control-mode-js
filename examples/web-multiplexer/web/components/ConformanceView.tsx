// examples/web-multiplexer/web/components/ConformanceView.tsx
//
// Protocol Conformance Dashboard — "every documented %notification and command,
// green or red." The genuine library conformance catalogue runs in this browser
// tab (see ConformanceStore): each row spins a real MockTmuxServer → real
// TmuxClient, drives one protocol surface, and reports the verdict. The demo IS
// the conformance suite — the same catalogue the unit gate runs. No tmux, no
// bridge: the deterministic column. The live-tmux column is the integration gate
// (tests/integration/conformance.test.ts), which runs this same catalogue's
// causable subset against a real server.
//
// Pure projection: reads `store.groups` / `store.summary` and drives the store
// via an explicit Re-run action and a run-on-mount effect.
//
// [LAW:dataflow-not-control-flow] Each section maps the same row render over its
//   array; an all-green run and a failing run differ only in row data (the
//   status value), not in which branches render.

import { useEffect } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  ScrollArea,
  Button,
  Code,
  ThemeIcon,
} from "@mantine/core";
import type { UiStore } from "../ui-store.ts";
import type {
  ConformanceStore,
  ConformanceRow,
  RowStatus,
} from "../conformance-store.ts";

interface Props {
  readonly store: ConformanceStore;
  readonly uiStore: UiStore;
}

// [LAW:one-source-of-truth] Status → presentation lives here once; the row and
// the summary badge both read it rather than re-deciding color per callsite.
const STATUS_STYLE: Record<
  RowStatus,
  { color: string; glyph: string; label: string }
> = {
  idle: { color: "gray", glyph: "·", label: "idle" },
  running: { color: "yellow", glyph: "…", label: "running" },
  pass: { color: "teal", glyph: "✓", label: "pass" },
  fail: { color: "red", glyph: "✗", label: "fail" },
};

function StatusDot({ status }: { readonly status: RowStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <ThemeIcon size={20} radius="xl" color={s.color} variant="light">
      <Text size="xs" fw={700}>
        {s.glyph}
      </Text>
    </ThemeIcon>
  );
}

function Row({ row }: { readonly row: ConformanceRow }) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      <StatusDot status={row.status} />
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" fw={500}>
            {row.title}
          </Text>
          <Code style={{ fontSize: 11 }}>{row.spec}</Code>
        </Group>
        {row.detail.length > 0 ? (
          <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
            {row.detail}
          </Text>
        ) : null}
      </Stack>
    </Group>
  );
}

export const ConformanceView = observer(function ConformanceView({
  store,
}: Props) {
  // Run on mount so the dashboard greets you with verdicts, not a blank grid.
  // [LAW:no-ambient-temporal-coupling] The effect is the single owner of the
  // initial run; the store never self-starts.
  useEffect(() => {
    void store.runAll();
  }, [store]);

  const { total, passed, failed, pending } = store.summary;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2} style={{ flex: 1 }}>
          <Group gap="xs">
            <Text fw={600}>Protocol Conformance Dashboard</Text>
            <Badge variant="light" color={store.allGreen ? "teal" : "grape"}>
              the demo IS the conformance suite
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            Every documented SPEC §23 message + the command-correlation contract,
            run against a real <Code>TmuxClient</Code> over an in-process{" "}
            <Code>MockTmuxServer</Code>. Only the tmux process is mocked — the
            parser, correlation FIFO, and sink path are the shipped library.
          </Text>
        </Stack>
        <Group gap="xs">
          <Badge size="lg" color="teal" variant="light">
            {passed} pass
          </Badge>
          <Badge
            size="lg"
            color={failed > 0 ? "red" : "gray"}
            variant={failed > 0 ? "filled" : "light"}
          >
            {failed} fail
          </Badge>
          {pending > 0 ? (
            <Badge size="lg" color="yellow" variant="light">
              {pending} pending
            </Badge>
          ) : null}
          <Button
            size="xs"
            variant="light"
            loading={store.running}
            onClick={() => void store.runAll()}
          >
            Re-run {total}
          </Button>
        </Group>
      </Group>

      <ScrollArea style={{ flex: 1 }} type="auto">
        <Stack gap="md">
          {store.groups.map((group) => (
            <Paper key={group.channel} withBorder p="sm" radius="md">
              <Stack gap="xs">
                <Text size="sm" fw={600} c="dimmed">
                  {group.label}
                </Text>
                {group.rows.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </Stack>
            </Paper>
          ))}
        </Stack>
      </ScrollArea>
    </Stack>
  );
});
