// examples/web-multiplexer/web/components/ConsoleFormatPlayground.tsx
//
// The Format Playground half of the Console tab (tmux-showcase-bhx.25.3): pick a
// target, type a tmux format string, and watch it evaluate — one-shot via
// `display-message -p`, or live via a `refresh-client -B` subscription. The
// component owns only view state (the format text being typed and a debounce
// timer); every evaluation, the subscription lifecycle, and persistence live in
// `ConsoleStore`. [LAW:one-source-of-truth] the store is the authority; this is
// a projection that calls setters and renders the discriminated result.
//
// The target picker is sourced entirely from `demoStore` — no separate
// enumeration of sessions/windows/panes. [LAW:one-source-of-truth]
//
// It is scoped to the *attached* session (`demoStore.currentSession`), because
// tmux evaluates format subscriptions in the control client's own session: a
// per-pane subscription for a pane in another session never fires. Offering
// only the attached session's panes keeps every target's promise whole — it
// works in BOTH one-shot and subscribed mode — instead of letting a
// cross-session pane silently hang the subscription. [LAW:composability]
// [LAW:no-silent-failure]

import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import {
  Box,
  Button,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import type { DemoStore, SessionInfo } from "../store.ts";
import type { ConsoleStore } from "../console-store.ts";
import {
  PLAYGROUND_PRESETS,
  type PlaygroundMode,
  type PlaygroundResult,
  type PlaygroundTarget,
} from "../console-types.ts";

interface Props {
  readonly store: ConsoleStore;
  readonly demoStore: DemoStore;
}

const MONO = "var(--mantine-font-family-monospace)";
// Settle delay before a typed format is committed to the store and evaluated, so
// keystrokes don't flood the bridge (and don't thrash a live subscription). This
// is the component's one timing concern — the store owns everything downstream.
// [LAW:no-ambient-temporal-coupling]
const DEBOUNCE_MS = 250;

// The synthetic "Active pane" option's Select value. Panes use their tmux token
// (`%id`) directly, which never collides with this sentinel.
const ACTIVE_VALUE = "active";

interface TargetOption {
  readonly value: string;
  readonly label: string;
}

/** Build the target dropdown from the attached session: the synthetic active-pane
 *  entry, then every pane in that session labelled by its window/pane path. Panes
 *  in other sessions are intentionally absent — their subscriptions never fire. */
function targetOptions(session: SessionInfo | null): TargetOption[] {
  const options: TargetOption[] = [{ value: ACTIVE_VALUE, label: "Active pane" }];
  if (session === null) return options;
  for (const window of session.windows) {
    for (const pane of window.panes) {
      options.push({
        value: `%${pane.id}`,
        label: `${session.name}:${window.index}.${pane.index} (${window.name})${
          pane.active ? " ▸" : ""
        }`,
      });
    }
  }
  return options;
}

function targetToValue(target: PlaygroundTarget): string {
  return target.kind === "active" ? ACTIVE_VALUE : target.target;
}

function valueToTarget(value: string): PlaygroundTarget {
  return value === ACTIVE_VALUE ? { kind: "active" } : { kind: "explicit", target: value };
}

/**
 * The result panel, discriminated on `status`. `idle` means nothing has
 * evaluated yet — in subscribed mode that is the genuine "the ~1s timer hasn't
 * fired" state, distinct from an evaluated-empty value, which renders a dimmed
 * `(empty)`. Errors carry tmux's real diagnostic in red.
 */
function ResultBody({
  result,
  mode,
}: {
  readonly result: PlaygroundResult;
  readonly mode: PlaygroundMode;
}): React.JSX.Element {
  if (result.status === "idle") {
    return (
      <Text size="sm" c="dimmed">
        {mode === "subscribed"
          ? "Subscribed — waiting for the first update (tmux pushes at most once per second)."
          : "No value yet."}
      </Text>
    );
  }
  if (result.status === "error") {
    return (
      <Text size="sm" c="red.7" style={{ fontFamily: MONO, whiteSpace: "pre-wrap" }}>
        {result.message}
      </Text>
    );
  }
  if (result.value.length === 0) {
    return (
      <Text size="sm" c="dimmed" style={{ fontFamily: MONO }}>
        (empty)
      </Text>
    );
  }
  return (
    <Text size="sm" style={{ fontFamily: MONO, whiteSpace: "pre-wrap" }}>
      {result.value}
    </Text>
  );
}

export const ConsoleFormatPlayground = observer(function ConsoleFormatPlayground({
  store,
  demoStore,
}: Props) {
  // The format text is the only view state: typing stays responsive locally,
  // then a debounce commits it to the store, which persists and re-evaluates.
  const [format, setFormat] = useState(store.playgroundFormat);

  // [LAW:no-ambient-temporal-coupling] the debounce timer is this effect, the
  // single owner of "when has typing settled enough to evaluate". It also fires
  // on mount (committing the hydrated format), which is what evaluates / installs
  // the subscription when the user opens the tab. The store's refresh() is
  // idempotent, so re-mounts (tab switches) don't thrash a live subscription.
  useEffect(() => {
    const handle = setTimeout(() => store.setPlaygroundFormat(format), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [format, store]);

  const options = targetOptions(demoStore.currentSession);
  const selectedValue = targetToValue(store.playgroundTarget);
  const targetInScope = options.some((o) => o.value === selectedValue);

  // Reconcile a stale persisted target — a pane from another session, or one
  // that no longer exists — back to the always-valid active pane, so a
  // subscription is never pointed at an unsubscribable pane. Runs on hydration
  // and whenever the attached session's pane set changes. [LAW:no-silent-failure]
  useEffect(() => {
    if (!targetInScope && store.playgroundTarget.kind === "explicit") {
      store.setPlaygroundTarget({ kind: "active" });
    }
  }, [targetInScope, store]);

  const result = store.playgroundResult;
  const showUpdates = store.playgroundMode === "subscribed" && result.status === "value";

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Group justify="space-between" align="baseline">
        <Title order={5}>Format Playground</Title>
        {showUpdates ? (
          <Text size="xs" c="dimmed">
            {result.updateCount} update{result.updateCount === 1 ? "" : "s"}
          </Text>
        ) : null}
      </Group>

      <Group gap="sm" align="flex-end" wrap="wrap">
        <Select
          size="xs"
          label="Target"
          data={options}
          value={targetInScope ? selectedValue : ACTIVE_VALUE}
          onChange={(v) => {
            if (v !== null) store.setPlaygroundTarget(valueToTarget(v));
          }}
          style={{ flex: "1 1 220px", minWidth: 0 }}
          searchable
          allowDeselect={false}
        />
        <SegmentedControl
          size="xs"
          data={[
            { value: "one-shot", label: "One-shot" },
            { value: "subscribed", label: "Subscribed" },
          ]}
          value={store.playgroundMode}
          onChange={(v) => store.setPlaygroundMode(v as PlaygroundMode)}
        />
      </Group>

      <Textarea
        label="Format"
        value={format}
        onChange={(e) => setFormat(e.currentTarget.value)}
        autosize
        minRows={2}
        maxRows={5}
        styles={{ input: { fontFamily: MONO } }}
        placeholder="#{session_name}: #{window_name}"
      />

      <Group gap="xs">
        <Text size="xs" c="dimmed">
          presets
        </Text>
        {PLAYGROUND_PRESETS.map((preset) => (
          <Button
            key={preset.format}
            size="compact-xs"
            variant="light"
            color="gray"
            onClick={() => setFormat(preset.format)}
            styles={{ label: { fontFamily: MONO } }}
            title={preset.format}
          >
            {preset.label}
          </Button>
        ))}
      </Group>

      <Box>
        <Text size="xs" c="dimmed" mb={2}>
          result
        </Text>
        <Box
          style={{
            borderLeft: `3px solid ${
              result.status === "error"
                ? "var(--mantine-color-red-6)"
                : "var(--mantine-color-default-border)"
            }`,
            paddingLeft: "var(--mantine-spacing-xs)",
            paddingTop: 2,
            paddingBottom: 2,
            minHeight: "2.5rem",
          }}
        >
          <ResultBody result={result} mode={store.playgroundMode} />
        </Box>
      </Box>
    </Stack>
  );
});
