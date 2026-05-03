// src/connectors/bridge/pane-client.ts
//
// Adapter: a `TmuxBridge` (single fan-in `onEvent` stream) → a typed
// `PaneSessionClient` that one or more `PaneSession` instances can drive.
//
// Why this lives in the library:
//   Every renderer-side consumer of `TmuxBridge` that wants to attach a
//   `PaneSession` needs the exact same fan-out shim — register one
//   `bridge.onEvent` listener, route by `ev.type` to per-event handler sets,
//   forward `execute` / `sendKeys` / `setPaneAction` straight through. Hand-
//   rolling it once per consumer was the demo's tax; the library pays it.
//
// Reuse: a single client returned by this function may be shared by N
// `PaneSession` instances — each session adds its own listener, paneId
// filtering happens inside the session. At most one `bridge.onEvent`
// registration exists while handlers are attached; it detaches again when
// the last handler is removed.
//
// [LAW:single-enforcer] One bridge-event registration owner; one dispatch
// table keyed by event type. The same lookup runs for every event — what
// differs is which `Set` is mutated.
// [LAW:locality-or-seam] This module IS the seam between the bridge's fan-
// in stream and PaneSession's typed `on/off` contract. Per-pane filtering
// stays in PaneSession; this layer only narrows by event type.

import type {
  ContinueMessage,
  ExtendedOutputMessage,
  OutputMessage,
  PauseMessage,
  TmuxMessage,
} from "../../protocol/types.js";
import type { PaneSessionClient } from "../../pane-session.js";
import type { TmuxBridge } from "../types.js";

type PaneEventName = "output" | "extended-output" | "pause" | "continue";

interface HandlerSets {
  readonly output: Set<(msg: OutputMessage) => void>;
  readonly "extended-output": Set<(msg: ExtendedOutputMessage) => void>;
  readonly pause: Set<(msg: PauseMessage) => void>;
  readonly continue: Set<(msg: ContinueMessage) => void>;
}

function emptySets(): HandlerSets {
  return {
    output: new Set(),
    "extended-output": new Set(),
    pause: new Set(),
    continue: new Set(),
  };
}

/**
 * Build a `PaneSessionClient` that routes `TmuxBridge` events to typed
 * handler sets and forwards command verbs straight through.
 *
 * The returned client may be reused across multiple `PaneSession`
 * instances — registering N sessions costs at most ONE `bridge.onEvent`
 * registration, not N. The single listener detaches when the last typed
 * handler is removed and re-attaches on later use.
 */
export function paneSessionClientFromBridge(
  bridge: TmuxBridge,
): PaneSessionClient {
  const sets = emptySets();
  let detachBridge: (() => void) | null = null;

  // [LAW:dataflow-not-control-flow] Every event runs the same lookup; the
  // event's `type` field decides which handler set fires. No control-flow
  // gating beyond the union narrowing required for type safety.
  const routeEvent = (ev: TmuxMessage): void => {
    if (ev.type === "output") {
      for (const h of sets.output) h(ev);
    } else if (ev.type === "extended-output") {
      for (const h of sets["extended-output"]) h(ev);
    } else if (ev.type === "pause") {
      for (const h of sets.pause) h(ev);
    } else if (ev.type === "continue") {
      for (const h of sets.continue) h(ev);
    }
  };
  const handlerCount = (): number =>
    sets.output.size +
    sets["extended-output"].size +
    sets.pause.size +
    sets.continue.size;
  const attachIfNeeded = (): void => {
    if (detachBridge === null) detachBridge = bridge.onEvent(routeEvent);
  };
  const detachIfIdle = (): void => {
    if (handlerCount() > 0 || detachBridge === null) return;
    detachBridge();
    detachBridge = null;
  };

  return {
    on(event: PaneEventName, handler: never): void {
      sets[event].add(handler);
      attachIfNeeded();
    },
    off(event: PaneEventName, handler: never): void {
      sets[event].delete(handler);
      detachIfIdle();
    },
    execute(command) {
      return bridge.execute(command);
    },
    sendKeys(target, keys) {
      return bridge.sendKeys(target, keys);
    },
    setPaneAction(paneId, action) {
      return bridge.setPaneAction(paneId, action);
    },
  } as PaneSessionClient;
}
