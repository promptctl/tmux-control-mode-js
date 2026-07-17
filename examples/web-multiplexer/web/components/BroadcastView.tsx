// examples/web-multiplexer/web/components/BroadcastView.tsx
//
// "Smart broadcast input with per-pane transforms" — type one template, pick N
// target panes, and send a payload resolved PER pane. Built-in variables
// (`${pane}`, `${title}`, `${session}`…) resolve from each pane itself; user
// override variables (`${host}`, `${user}`…) get a per-pane value in the grid.
//
// THE WRITE AXIS: every other showcase taps a pane's OUTPUT; this drives its
// INPUT. Native tmux broadcast sends identical keystrokes to one window's panes;
// this resolves a distinct command per target across any windows/sessions, over
// the same `sendKeys` (`send-keys -H`) the library already exposes.
//
// [LAW:effects-at-boundaries] The view only renders state and routes intent
//   (edit template, toggle target, type an override, click send); the store owns
//   the `sendKeys` fan-out and the live-model projection; the engine owns the
//   template parse + per-pane resolution.
// [LAW:one-source-of-truth] The preview renders the store's `resolutions` — the
//   SAME value `send` transmits — with control bytes made visible, so what you
//   read is byte-identical to what goes on the wire.

import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Text,
  Badge,
  Button,
  Textarea,
  TextInput,
  Switch,
  Code,
  ScrollArea,
  Divider,
} from "@mantine/core";
import type { BroadcastStore } from "../broadcast-store.ts";

const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

const READY_COLOR = "#2ea043"; // pane resolves — ready to send
const BLOCKED_COLOR = "#f85149"; // pane blocked on an unbound variable

interface Props {
  readonly store: BroadcastStore;
}

/**
 * Make the control bytes that a broadcast actually puts on the wire visible in
 * the preview, so the rendered text is byte-truthful (the appended Enter shows as
 * `␍`, not as an invisible jump). Presentation only — the engine owns the bytes.
 */
function visibleControls(s: string): string {
  return s.replace(/\r/g, "␍").replace(/\n/g, "␊").replace(/\t/g, "␉");
}

export const BroadcastView = observer(function BroadcastView({ store }: Props) {
  const targets = store.targets;
  const selected = store.selectedTargets;
  const overrideVars = store.overrideVars;
  const previews = store.resolutions;

  return (
    <Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
      <div>
        <Group gap="xs" align="center">
          <Text fw={600} size="lg">
            Smart Broadcast
          </Text>
          <Badge variant="light" color="grape">
            input axis
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          Type once, send to many — but resolved per pane. Built-ins{" "}
          <Code>{"${pane}"}</Code> <Code>{"${title}"}</Code>{" "}
          <Code>{"${session}"}</Code> resolve from each pane; your own variables
          like <Code>{"${host}"}</Code> take a per-pane value below. tmux's
          native broadcast sends identical keys to one window — this transforms
          per target across every session.
        </Text>
      </div>

      <Textarea
        label="Template — supports ${var}, $var, and $$ for a literal $"
        value={store.template}
        onChange={(e) => store.setTemplate(e.currentTarget.value)}
        autosize
        minRows={2}
        maxRows={6}
        styles={{ input: { fontFamily: FONT_FAMILY } }}
      />

      <Group justify="space-between" align="center">
        <Switch
          label="Append Enter (run the command)"
          checked={store.appendEnter}
          onChange={(e) => store.setAppendEnter(e.currentTarget.checked)}
        />
        <Group gap="xs">
          <Text size="sm" c="dimmed">
            {selected.length} of {targets.length} panes selected
          </Text>
          <Button size="xs" variant="default" onClick={() => store.selectAll()}>
            Select all
          </Button>
          <Button
            size="xs"
            variant="default"
            onClick={() => store.selectNone()}
          >
            Select none
          </Button>
        </Group>
      </Group>

      <Divider label="Targets" labelPosition="left" />
      {targets.length === 0 ? (
        <Text size="sm" c="dimmed">
          No panes visible — open a tmux session to broadcast to.
        </Text>
      ) : (
        <ScrollArea.Autosize mah={180}>
          <Group gap="xs">
            {targets.map((t) => (
              <Badge
                key={t.facts.paneId}
                variant={t.selected ? "filled" : "outline"}
                color={t.selected ? "grape" : "gray"}
                style={{ cursor: "pointer", fontFamily: FONT_FAMILY }}
                onClick={() => store.toggleSelected(t.facts.paneId)}
                title={t.facts.title}
              >
                {t.label}
              </Badge>
            ))}
          </Group>
        </ScrollArea.Autosize>
      )}

      {overrideVars.length > 0 && selected.length > 0 && (
        <>
          <Divider label="Per-pane overrides" labelPosition="left" />
          <ScrollArea.Autosize mah={220}>
            <Stack gap="xs">
              {selected.map((t) => (
                <Group
                  key={t.facts.paneId}
                  gap="xs"
                  wrap="nowrap"
                  align="center"
                >
                  <Text
                    size="sm"
                    style={{
                      fontFamily: FONT_FAMILY,
                      width: 160,
                      flexShrink: 0,
                    }}
                  >
                    {t.label}
                  </Text>
                  {overrideVars.map((v) => (
                    <TextInput
                      key={v}
                      size="xs"
                      placeholder={`$${v}`}
                      value={store.overrideOf(t.facts.paneId, v)}
                      onChange={(e) =>
                        store.setOverride(
                          t.facts.paneId,
                          v,
                          e.currentTarget.value,
                        )
                      }
                      styles={{ input: { fontFamily: FONT_FAMILY } }}
                    />
                  ))}
                </Group>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        </>
      )}

      <Divider
        label="Preview — exactly the bytes that go on the wire"
        labelPosition="left"
      />
      {previews.length === 0 ? (
        <Text size="sm" c="dimmed">
          Select one or more panes to preview the resolved payloads.
        </Text>
      ) : (
        <ScrollArea.Autosize mah={260}>
          <Stack gap={4}>
            {previews.map(({ label, resolution }) => (
              <Group
                key={resolution.paneId}
                gap="xs"
                wrap="nowrap"
                align="center"
              >
                <Text
                  size="sm"
                  style={{ fontFamily: FONT_FAMILY, width: 160, flexShrink: 0 }}
                >
                  {label}
                </Text>
                {resolution.kind === "resolved" ? (
                  <Code
                    style={{
                      fontFamily: FONT_FAMILY,
                      borderLeft: `3px solid ${READY_COLOR}`,
                    }}
                  >
                    {visibleControls(resolution.text) || "(empty)"}
                  </Code>
                ) : (
                  <Text size="sm" style={{ color: BLOCKED_COLOR }}>
                    blocked — unbound: {resolution.missing.join(", ")}
                  </Text>
                )}
              </Group>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      )}

      <Group justify="space-between" align="center" mt="auto">
        <Group gap="xs">
          {store.blockedCount > 0 && (
            <Badge color="red" variant="light">
              {store.blockedCount} blocked
            </Badge>
          )}
          {store.lastSend !== null && (
            <Text size="sm" c="dimmed">
              sent {store.lastSend.sentBytes} bytes to{" "}
              {store.lastSend.sentPanes} pane
              {store.lastSend.sentPanes === 1 ? "" : "s"}
              {store.lastSend.blockedPanes > 0
                ? ` · ${store.lastSend.blockedPanes} blocked`
                : ""}
              {store.lastSend.failedPanes > 0
                ? ` · ${store.lastSend.failedPanes} failed`
                : ""}
            </Text>
          )}
        </Group>
        <Button
          color="grape"
          disabled={store.sendableCount === 0}
          onClick={() => store.send()}
        >
          Broadcast to {store.sendableCount} pane
          {store.sendableCount === 1 ? "" : "s"}
        </Button>
      </Group>
    </Stack>
  );
});
