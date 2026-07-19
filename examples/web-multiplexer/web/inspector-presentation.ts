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
import { summarizeEvent } from "./event-summary.ts";

export interface Presentation {
  readonly arrow: string;
  readonly color: string;
  readonly type: string;
  readonly summary: string;
}

export function presentFor(
  w: WireEntry,
  paneLabels: Map<number, string>,
): Presentation {
  if (w.dir === "out") {
    const msg = w.msg;
    // [LAW:dataflow-not-control-flow] Every outbound kind labels the same
    // way — `<kind> #<id>` — so the type is derived from the value, not a
    // per-branch literal. Only the summary carries payload-specific detail;
    // the payload-less kinds (detach, startFirehose, stopFirehose) have none.
    // Deriving the label keeps it truthful for any kind added to
    // ClientToServer later, with no branch to forget.
    const summary =
      msg.kind === "execute"
        ? msg.command
        : msg.kind === "sendKeys"
          ? `${msg.target}  ${escapeForDisplay(msg.keys)}`
          : "";
    return {
      arrow: "↑",
      color: "var(--mantine-color-blue-6)",
      type: `${msg.kind} #${msg.id}`,
      summary,
    };
  }
  if (w.dir === "in-event") {
    return {
      arrow: "↓",
      color: "var(--mantine-color-teal-6)",
      type: `%${w.event.type}`,
      summary: summarizeEvent(w.event, paneLabels),
    };
  }
  if (w.dir === "in-response") {
    const head = w.response.output[0] ?? "";
    const more =
      w.response.output.length > 1 ? ` …+${w.response.output.length - 1}` : "";
    return {
      arrow: "↓",
      color: "var(--mantine-color-grape-6)",
      type: `response #${w.id}${w.response.success ? "" : " !err"}`,
      summary: `${head}${more}`,
    };
  }
  return {
    arrow: "⚠",
    color: "var(--mantine-color-red-6)",
    type: `error${w.id !== null ? ` #${w.id}` : ""}`,
    summary: w.message,
  };
}

export function badgeColor(dir: WireEntry["dir"]): string {
  if (dir === "out") return "blue";
  if (dir === "in-event") return "teal";
  if (dir === "in-response") return "grape";
  return "red";
}

export function renderPayload(w: WireEntry): string {
  if (w.dir === "out") return JSON.stringify(w.msg, null, 2);
  if (w.dir === "in-event") {
    const ev = w.event;
    if (ev.type === "output" || ev.type === "extended-output") {
      // Render the Uint8Array bytes as escaped ASCII so the inspector
      // can serve as a raw-byte viewer.
      const ageNote = ev.type === "extended-output" ? `  age=${ev.age}ms` : "";
      return `paneId=%${ev.paneId}${ageNote}\nbytes=${prettyBytes(ev.data, 96)}\n\n${JSON.stringify({ ...ev, data: `<${ev.data.byteLength} bytes>` }, null, 2)}`;
    }
    return JSON.stringify(ev, null, 2);
  }
  if (w.dir === "in-response") {
    const req =
      w.request !== null
        ? JSON.stringify(w.request, null, 2)
        : "(request evicted from ring)";
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
  if (abs < 1) return "<1ms";
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
function escapeForDisplay(s: string): string {
  let out = "";
  for (const ch of s) out += escapeByte(ch.charCodeAt(0));
  return out;
}
