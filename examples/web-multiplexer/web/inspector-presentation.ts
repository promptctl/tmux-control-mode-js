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
import { prettyBytes } from "./format-bytes.ts";
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
// JSX (round-trip badges, per-row latency column).
export function formatMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function escapeForDisplay(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0x1b) out += "\\x1b";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else out += `\\x${c.toString(16).padStart(2, "0")}`;
  }
  return out;
}
