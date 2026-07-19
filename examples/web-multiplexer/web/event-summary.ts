// examples/web-multiplexer/web/event-summary.ts
//
// One-line summary of a control-mode event for the Protocol Inspector's
// timeline. Pure: a TmuxMessage plus a pane-label lookup in, a single
// display line out — no MobX, no client, no effects. [LAW:effects-at-boundaries]
//
// This is the shared home for inspector-style event summarization. The
// summary stays on ONE line (the timeline is a dense table), which is why
// byte previews are capped short and labels are terse.
//
// [LAW:single-enforcer] SD5 (tmux-complexity-lkg.15) collapses the three
// hand-maintained TmuxMessage summarizers (this one, DebugPanel's `summarize`,
// inspector-store's `eventSearchTail`) into one exhaustive switch routed
// through this module. GM8 establishes the seam; the collapse lands in SD5.

import type { TmuxMessage } from "@promptctl/tmux-control-mode-js";
import { prettyBytes } from "./format-bytes.ts";

function paneLabel(id: number, labels: Map<number, string>): string {
  return labels.get(id) ?? `%${id}`;
}

export function summarizeEvent(
  ev: TmuxMessage,
  labels: Map<number, string>,
): string {
  if (ev.type === "output") {
    return `${paneLabel(ev.paneId, labels)}  "${prettyBytes(ev.data, 64)}"`;
  }
  if (ev.type === "extended-output") {
    return `${paneLabel(ev.paneId, labels)} age=${ev.age}ms  "${prettyBytes(ev.data, 64)}"`;
  }
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

// [LAW:types-are-the-program] If a TmuxMessage variant is added upstream
// without a branch above, `ev` is no longer `never` here and this fails to
// compile — the summarizer stays total by construction, never silently
// returning an empty line for an unhandled type. [LAW:no-silent-failure]
function assertNever(ev: never): never {
  throw new Error(
    `summarizeEvent: unhandled message variant ${JSON.stringify(ev)}`,
  );
}
