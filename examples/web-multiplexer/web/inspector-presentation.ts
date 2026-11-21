// examples/web-multiplexer/web/inspector-presentation.ts
//
// Presentation policy for the Protocol Inspector — the map from a wire
// entry to how it should look and read. Pure: a WireEntry in, display
// data out (arrow/color/type/summary, a badge color, a payload string).
// No JSX, no MobX, no effects. [LAW:effects-at-boundaries]
//
// [LAW:dataflow-not-control-flow] The timeline row and detail panel render
// the same shape for every entry; per-direction variation lives here as
// data (the Presentation record), not as branches in the view.

import type { WireEntry } from "./bridge.ts";
import { prettyBytes, escapeByte } from "./format-bytes.ts";
import { notificationType, summarizeNotification } from "./event-summary.ts";

export interface Presentation {
  readonly arrow: string;
  readonly color: string;
  readonly type: string;
  readonly summary: string;
}

export interface WireDirection {
  readonly arrow: string;
  readonly label: string;
  /** A Mantine color name. */
  readonly color: string;
}

// [LAW:one-source-of-truth] Each direction's arrow, label and color, read by
//   the timeline row, the detail badge and the filter chips alike.
// [LAW:types-are-the-program] Keyed by every direction: a new direction
//   without a row does not compile.
export const WIRE_DIRECTIONS: Record<WireEntry["dir"], WireDirection> = {
  out: { arrow: "↑", label: "out", color: "blue" },
  "in-event": { arrow: "↓", label: "event", color: "teal" },
  "in-output": { arrow: "↓", label: "output", color: "cyan" },
  "in-response": { arrow: "↓", label: "resp", color: "grape" },
  "in-error": { arrow: "⚠", label: "err", color: "red" },
};

// [LAW:types-are-the-program] exception: Object.keys widens to string[];
//   these are exactly WIRE_DIRECTIONS' keys, in its order.
export const WIRE_DIRECTION_ORDER = Object.keys(
  WIRE_DIRECTIONS,
) as readonly WireEntry["dir"][];

export function presentFor(
  w: WireEntry,
  paneLabels: Map<number, string>,
): Presentation {
  const { arrow, color } = WIRE_DIRECTIONS[w.dir];
  return {
    arrow,
    color: `var(--mantine-color-${color}-6)`,
    ...describe(w, paneLabels),
  };
}

function describe(
  w: WireEntry,
  paneLabels: Map<number, string>,
): Pick<Presentation, "type" | "summary"> {
  if (w.dir === "out") {
    const call = w.call;
    // [LAW:dataflow-not-control-flow] Every outbound kind labels the same
    // way — `<kind> #<id>` — so the type is derived from the value, not a
    // per-branch literal. Only the summary carries payload-specific detail.
    const summary =
      call.kind === "execute"
        ? call.command
        : `${call.target}  ${escapeForDisplay(call.keys)}`;
    return { type: `${call.kind} #${call.id}`, summary };
  }
  if (w.dir === "in-event" || w.dir === "in-output") {
    return {
      type: `%${notificationType(w)}`,
      summary: summarizeNotification(w, paneLabels),
    };
  }
  if (w.dir === "in-response") {
    const head = w.response.output[0] ?? "";
    const more =
      w.response.output.length > 1 ? ` …+${w.response.output.length - 1}` : "";
    return {
      type: `response #${w.id}${w.response.success ? "" : " !err"}`,
      summary: `${head}${more}`,
    };
  }
  return {
    type: `error${w.id !== null ? ` #${w.id}` : ""}`,
    summary: w.message,
  };
}

export function badgeColor(dir: WireEntry["dir"]): string {
  return WIRE_DIRECTIONS[dir].color;
}

export function renderPayload(w: WireEntry): string {
  if (w.dir === "out") return JSON.stringify(w.call, null, 2);
  if (w.dir === "in-event") return JSON.stringify(w.event, null, 2);
  if (w.dir === "in-output") {
    // Render the bytes as escaped ASCII so the inspector can serve as a
    // raw-byte viewer.
    const { paneId, data } = w.chunk;
    return `paneId=%${paneId}\nbytes=${prettyBytes(data, 96)}\n\n(${data.byteLength} bytes)`;
  }
  if (w.dir === "in-response") {
    const req = JSON.stringify(w.call, null, 2);
    return `latency: ${formatMs(w.latencyMs)}\nsuccess: ${w.response.success}\n\n--- request ---\n${req}\n\n--- response ---\n${JSON.stringify(w.response, null, 2)}`;
  }
  return JSON.stringify({ id: w.id, message: w.message }, null, 2);
}

// Duration formatter shared by the payload renderer and the inspector's
// JSX (round-trip badges, per-row latency column). Honest across the whole
// numeric domain: the magnitude picks the unit bucket and the sign is
// preserved, so a negative input reads as a negative duration rather than
// collapsing into "<1ms". [LAW:types-are-the-program]
export function formatMs(ms: number): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  if (abs < 1) return `${sign}<1ms`;
  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;
  return `${sign}${(abs / 1000).toFixed(2)}s`;
}

// Inter-event delta for the timeline: a non-negative gap reads `+42ms`;
// an out-of-order (negative) delta defers to formatMs's own sign so it
// reads `-1.00s`, never the misleading `+<1ms`.
export function formatDelta(ms: number): string {
  return ms >= 0 ? `+${formatMs(ms)}` : formatMs(ms);
}

// The key string for a sendKeys entry, escaped for one-line display.
// [LAW:single-enforcer] The per-code-unit escape decision is owned by
// escapeByte in ./format-bytes.ts; this only adapts a string's code units
// to it, so the inspector and prettyBytes share one escape table.
//
// Iterate UTF-16 code units, not code points: an astral character escapes
// both of its surrogates rather than silently dropping the low half.
// [LAW:no-silent-failure]
function escapeForDisplay(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += escapeByte(s.charCodeAt(i));
  return out;
}
