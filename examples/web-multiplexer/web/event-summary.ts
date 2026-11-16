// examples/web-multiplexer/web/event-summary.ts
//
// One-line summary of a control-mode notification, or of a chunk of pane
// output, for the Protocol Inspector's timeline. Pure: the message plus a
// pane-label lookup in, a single display line out — no MobX, no client, no
// effects. [LAW:effects-at-boundaries]
//
// This is the shared home for inspector-style event summarization. The
// summary stays on ONE line (the timeline is a dense table), which is why
// byte previews are capped short and labels are terse.
//
// [LAW:single-enforcer] SD5 (tmux-complexity-lkg.15) collapsed the three
// hand-maintained TmuxMessage summarizers (this one, DebugPanel's `summarize`,
// inspector-store's `eventSearchTail`) into this one exhaustive switch; GM8
// established the seam, SD5 landed the collapse.
//
// The byte preview is wrapped in ⟨…⟩, not a quote: `escapeByte` (format-
// bytes.ts) deliberately passes 0x22 (`"`) through unescaped in its
// printable range — that table's job is byte-safety, not protecting a
// caller's chosen delimiter — so a literal quote in pane output would
// otherwise terminate the wrapper early and read as two values.

import type {
  ChunkPayload,
  EmitterTmuxMessage,
} from "@promptctl/tmux-control-mode-js/browser";
import type { WireEntry } from "./bridge.ts";
import { prettyBytes } from "./format-bytes.ts";

/**
 * An inbound tmux notification as the wire log records it: a parsed event,
 * or a chunk of `%output` that rode the pane-bytes channel.
 */
export type Notification = Extract<
  WireEntry,
  { dir: "in-event" | "in-output" }
>;

export function isNotification(w: WireEntry): w is Notification {
  return w.dir === "in-event" || w.dir === "in-output";
}

// [LAW:one-source-of-truth] The notification's tmux name — the key the
//   event-type filter hides by — whichever channel carried it. Pane bytes
//   are `output`, the name they had as an `in-event`, so a hidden `output`
//   saved before the bytes got their own channel still hides them.
export function notificationType(n: Notification): string {
  return n.dir === "in-event" ? n.event.type : "output";
}

export function summarizeNotification(
  n: Notification,
  labels: Map<number, string>,
): string {
  return n.dir === "in-event"
    ? summarizeEvent(n.event, labels)
    : summarizeOutput(n.chunk, labels);
}

function paneLabel(id: number, labels: Map<number, string>): string {
  return labels.get(id) ?? `%${id}`;
}

export function summarizeOutput(
  chunk: ChunkPayload,
  labels: Map<number, string>,
): string {
  return `${paneLabel(chunk.paneId, labels)}  ⟨${prettyBytes(chunk.data, 64)}⟩`;
}

export function summarizeEvent(
  ev: EmitterTmuxMessage,
  labels: Map<number, string>,
): string {
  if (
    ev.type === "pause" ||
    ev.type === "continue" ||
    ev.type === "pane-mode-changed"
  ) {
    return paneLabel(ev.paneId, labels);
  }
  if (ev.type === "window-pane-changed") {
    return `@${ev.windowId} → ${paneLabel(ev.paneId, labels)}`;
  }
  if (
    ev.type === "window-add" ||
    ev.type === "window-close" ||
    ev.type === "unlinked-window-add" ||
    ev.type === "unlinked-window-close"
  ) {
    return `@${ev.windowId}`;
  }
  if (ev.type === "window-renamed" || ev.type === "unlinked-window-renamed") {
    return `@${ev.windowId} → "${ev.name}"`;
  }
  if (ev.type === "layout-change")
    return `@${ev.windowId} layout=${ev.windowLayout}`;
  if (ev.type === "session-changed" || ev.type === "session-renamed") {
    return `$${ev.sessionId} "${ev.name}"`;
  }
  if (ev.type === "session-window-changed")
    return `$${ev.sessionId} → @${ev.windowId}`;
  if (ev.type === "client-session-changed") {
    return `${ev.clientName} → $${ev.sessionId} "${ev.name}"`;
  }
  if (ev.type === "client-detached") return ev.clientName;
  if (ev.type === "subscription-changed") {
    return `"${ev.name}" $${ev.sessionId}:@${ev.windowId}.${paneLabel(ev.paneId, labels)}`;
  }
  if (ev.type === "begin" || ev.type === "end" || ev.type === "error") {
    return `cmd #${ev.commandNumber}`;
  }
  if (ev.type === "exit") return ev.reason ?? "(clean)";
  if (ev.type === "message") return ev.message;
  if (ev.type === "config-error") return ev.error;
  if (ev.type === "paste-buffer-changed" || ev.type === "paste-buffer-deleted")
    return ev.name;
  // sessions-changed carries no fields — there is nothing to summarize, so an
  // empty line is the correct (not accidental) result.
  if (ev.type === "sessions-changed") return "";
  return assertNever(ev);
}

// [LAW:types-are-the-program] If a notification variant is added upstream
// without a branch above, `ev` is no longer `never` here and this fails to
// compile — the summarizer stays total by construction, never silently
// returning an empty line for an unhandled type. [LAW:no-silent-failure]
function assertNever(ev: never): never {
  throw new Error(
    `summarizeEvent: unhandled message variant ${JSON.stringify(ev)}`,
  );
}
