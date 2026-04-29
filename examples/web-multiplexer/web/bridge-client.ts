// examples/web-multiplexer/web/bridge-client.ts
//
// BridgeClient — adapts a renderer-side `TmuxBridge` (WebSocket / Electron
// IPC) to the library's `TmuxModelClient` interface so `TmuxModel` can run
// in the renderer against an opaque IPC proxy.
//
// The underlying bridge exposes only `execute()` and `onEvent()`. This
// adapter layers on top:
//   - Typed `subscribeSessions/Windows/Panes` — auto-allocates names
//     client-side, builds the format string with `buildScopedFormat`, fires
//     `refresh-client -B` over `bridge.execute`, parses inbound
//     `%subscription-changed` rows with `parseRows`.
//   - Typed `on/off` for the four `TmuxModel`-relevant message types — a
//     single `bridge.onEvent` listener fans out to typed handler sets.
//   - `subscriptions-reset` — fired whenever the bridge re-enters `ready`
//     after having been `closed`. The server-side TmuxClient at that point
//     is a fresh process with no live subscriptions; the live entries are
//     re-issued under the same names so existing handles keep routing.
//
// [LAW:single-enforcer] All `%subscription-changed` routing for the
// renderer happens here. DemoStore no longer maintains a parallel router.
//
// [LAW:dataflow-not-control-flow] Subscription delivery, typed-event
// dispatch, and reconnect re-issue all run unconditionally — the entry's
// `disposed` flag and the connection state decide *what* happens, not
// *whether* the operation runs.

import type {
  CommandResponse,
  TmuxMessage,
} from "../../../src/protocol/types.js";
import type { TmuxEventMap } from "../../../src/emitter.js";
// [LAW:one-way-deps] Deep-import the renderer-safe submodules — the public
// barrel at `src/index.js` would drag in `spawnTmux` (Node-only).
import type { SubscriptionHandle } from "../../../src/client.js";
import type { TmuxModelClient } from "../../../src/model/index.js";
import {
  buildScopedFormat,
  parseRows,
  type Scope,
} from "../../../src/subscriptions.js";
import {
  refreshClientSubscribe,
  refreshClientUnsubscribe,
} from "../../../src/protocol/encoder.js";
import type { ConnState, TmuxBridge } from "./bridge.ts";

type ModelEvent =
  | "client-session-changed"
  | "layout-change"
  | "session-window-changed"
  | "window-pane-changed";

interface SubscriptionEntry {
  readonly format: string;
  readonly handler: (value: string) => void;
  readonly name: string;
  disposed: boolean;
}

// `bridge.execute` re-wraps with a trailing LF on the server side
// (TmuxClient.execute → buildCommand). The encoder we re-use here also
// appends LF; strip it so we don't send a double-LF wire string.
function stripLf(wire: string): string {
  return wire.endsWith("\n") ? wire.slice(0, -1) : wire;
}

export class BridgeClient implements TmuxModelClient {
  private readonly bridge: TmuxBridge;

  // [LAW:one-source-of-truth] Single name→entry router map. The
  // `subscription-changed` listener consults this map; nothing else does.
  private readonly subs = new Map<string, SubscriptionEntry>();
  private subCounter = 0;

  // Typed event fan-out for the four messages TmuxModel listens to.
  private readonly typedListeners = new Map<
    ModelEvent,
    Set<(ev: TmuxMessage) => void>
  >();
  private readonly resetListeners = new Set<() => void>();

  // Track the most recent terminal state to detect "ready after closed"
  // (bridge dropped + reconnected). On the *first* `ready` we don't fire
  // a reset because consumers haven't subscribed yet.
  private hadReadyOnce = false;
  private lastState: ConnState = "connecting";

  private disposed = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(bridge: TmuxBridge) {
    this.bridge = bridge;
    this.cleanups.push(bridge.onEvent((ev) => this.routeEvent(ev)));
    this.cleanups.push(bridge.onState((s) => this.handleStateChange(s)));
  }

  /** Detach all listeners and forget every subscription. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    this.subs.clear();
    this.typedListeners.clear();
    this.resetListeners.clear();
  }

  // ---------------------------------------------------------------------------
  // TmuxModelClient — execute
  // ---------------------------------------------------------------------------

  execute(command: string): Promise<CommandResponse> {
    return this.bridge.execute(command);
  }

  // ---------------------------------------------------------------------------
  // TmuxModelClient — typed subscriptions
  // ---------------------------------------------------------------------------

  subscribeSessions<F extends string>(
    fields: readonly F[],
    handler: (rows: Record<F, string>[]) => void,
  ): Promise<SubscriptionHandle> {
    return this.subscribeScoped("S", fields, handler);
  }

  subscribeWindows<F extends string>(
    fields: readonly F[],
    handler: (rows: Record<F, string>[]) => void,
  ): Promise<SubscriptionHandle> {
    return this.subscribeScoped("S:W", fields, handler);
  }

  subscribePanes<F extends string>(
    fields: readonly F[],
    handler: (rows: Record<F, string>[]) => void,
  ): Promise<SubscriptionHandle> {
    return this.subscribeScoped("S:W:P", fields, handler);
  }

  private async subscribeScoped<F extends string>(
    scope: Scope,
    fields: readonly F[],
    handler: (rows: Record<F, string>[]) => void,
  ): Promise<SubscriptionHandle> {
    const format = buildScopedFormat(scope, fields);
    const wrapped = (value: string): void => handler(parseRows(value, fields));
    const name = `bridge-cm-sub-${++this.subCounter}`;
    const entry: SubscriptionEntry = {
      format,
      handler: wrapped,
      name,
      disposed: false,
    };
    // Register the route synchronously so a `%subscription-changed` event
    // racing with our refresh-client response cannot bypass the router.
    this.subs.set(name, entry);
    try {
      await this.bridge.execute(stripLf(refreshClientSubscribe(name, "", format)));
    } catch (err) {
      this.subs.delete(name);
      entry.disposed = true;
      throw err;
    }
    return {
      dispose: () => {
        if (entry.disposed) return;
        entry.disposed = true;
        this.subs.delete(name);
        // Fire-and-forget unsubscribe; the route is already torn down so
        // any in-flight delivery is silently dropped.
        void this.bridge
          .execute(stripLf(refreshClientUnsubscribe(name)))
          .catch(() => undefined);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // TmuxModelClient — typed on/off
  // ---------------------------------------------------------------------------

  on<K extends ModelEvent>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(event: "subscriptions-reset", handler: () => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    if (event === "subscriptions-reset") {
      this.resetListeners.add(handler as () => void);
      return;
    }
    const key = event as ModelEvent;
    let set = this.typedListeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.typedListeners.set(key, set);
    }
    set.add(handler as (ev: TmuxMessage) => void);
  }

  off<K extends ModelEvent>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(event: "subscriptions-reset", handler: () => void): void;
  off(event: string, handler: (...args: never[]) => void): void {
    if (event === "subscriptions-reset") {
      this.resetListeners.delete(handler as () => void);
      return;
    }
    const key = event as ModelEvent;
    this.typedListeners.get(key)?.delete(handler as (ev: TmuxMessage) => void);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  // [LAW:single-enforcer] Single inbound event router. `subscription-changed`
  // → matching entry's handler; the typed events fan out to per-type
  // listener sets. Anything else is dropped (TmuxModel doesn't observe it
  // through this client).
  private routeEvent(ev: TmuxMessage): void {
    if (this.disposed) return;
    if (ev.type === "subscription-changed") {
      const entry = this.subs.get(ev.name);
      // [LAW:no-defensive-null-guards] Missing entry is data — event
      // arrived after dispose, or for a name we don't own.
      if (entry !== undefined && !entry.disposed) entry.handler(ev.value);
      return;
    }
    if (
      ev.type === "client-session-changed" ||
      ev.type === "layout-change" ||
      ev.type === "session-window-changed" ||
      ev.type === "window-pane-changed"
    ) {
      const set = this.typedListeners.get(ev.type);
      if (set === undefined) return;
      for (const h of set) h(ev);
    }
  }

  // [LAW:single-enforcer] Reconnect handling lives here only. When the
  // bridge transitions back to `ready` after having been `closed`, the
  // server-side TmuxClient is a fresh process with no live subscriptions —
  // re-issue every entry under its existing name so consumer-held handles
  // keep working, and notify TmuxModel to clear cached state.
  private handleStateChange(state: ConnState): void {
    if (this.disposed) return;
    const prev = this.lastState;
    this.lastState = state;
    if (state !== "ready") return;

    if (!this.hadReadyOnce) {
      this.hadReadyOnce = true;
      return;
    }
    // ready after a closed/connecting cycle — the underlying tmux server
    // has lost everything we registered.
    if (prev === "closed" || prev === "connecting") {
      for (const handler of this.resetListeners) handler();
      for (const entry of this.subs.values()) {
        if (entry.disposed) continue;
        void this.bridge
          .execute(stripLf(refreshClientSubscribe(entry.name, "", entry.format)))
          .catch(() => undefined);
      }
    }
  }
}
