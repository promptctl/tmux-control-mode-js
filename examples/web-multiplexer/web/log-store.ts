// examples/web-multiplexer/web/log-store.ts
//
// LogStore — the demo's two rolling ring buffers: the most recent wire
// events and the most recent human-readable errors. It is a pure sink: fed
// from outside (the bridge's onEvent / onError, plus store-side subscribe
// failures), it holds no model state and answers no queries beyond "what are
// the last N". [LAW:decomposition]
//
// NOTE: this duplicates InspectorStore.entries (a second, larger ring over
// the same wire). Collapsing the two into one WireLog is SD5's job
// (tmux-complexity-lkg.15) — GM7 only lifts the buffer out of DemoStore.

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
