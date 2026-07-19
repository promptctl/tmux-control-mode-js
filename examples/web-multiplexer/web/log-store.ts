// examples/web-multiplexer/web/log-store.ts
//
// LogStore — the demo's two rolling ring buffers: the most recent wire
// events and the most recent human-readable errors. It is a pure sink: fed
// from outside (the bridge's onEvent / onError, plus store-side subscribe
// failures), it holds no model state and answers no queries beyond "what are
// the last N". [LAW:decomposition]
//
// NOTE: this is a parallel ring-buffer sink to InspectorStore.entries — both
// are fed from the same wire, but they hold different representations:
// LogStore keeps parsed `TmuxMessage` events (+ timestamped error strings)
// while InspectorStore keeps richer protocol-level `WireEntry` records
// (direction, timing, request/response correlation). Collapsing them (SD5,
// tmux-complexity-lkg.15) therefore needs a shared transform layer, not a
// trivial merge. GM7 only lifts this buffer out of DemoStore.

import { makeAutoObservable } from "mobx";
import type { TmuxMessage } from "@promptctl/tmux-control-mode-js";

const EVENT_CAP = 200;
const ERROR_CAP = 50;

export class LogStore {
  events: TmuxMessage[] = [];
  errors: string[] = [];

  constructor() {
    makeAutoObservable(this);
  }

  pushEvent(ev: TmuxMessage): void {
    this.events = [ev, ...this.events].slice(0, EVENT_CAP);
  }

  pushError(message: string): void {
    const stamp = new Date().toLocaleTimeString();
    this.errors = [`${stamp} — ${message}`, ...this.errors].slice(0, ERROR_CAP);
  }

  clearEvents(): void {
    this.events = [];
  }

  clearErrors(): void {
    this.errors = [];
  }
}
