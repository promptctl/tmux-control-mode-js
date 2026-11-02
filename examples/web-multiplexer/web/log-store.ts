// examples/web-multiplexer/web/log-store.ts
//
// LogStore — the demo's rolling ring buffer of human-readable errors. It is
// a pure sink: fed from outside (the bridge's onError, plus store-side
// subscribe failures that never cross the wire and so have no WireEntry),
// it holds no model state and answers no queries beyond "what are the last
// N". [LAW:decomposition]
//
// The parallel event ring this used to keep (`events`, duplicating the
// in-event subset of InspectorStore.entries) was collapsed in SD5
// (tmux-complexity-lkg.15) — DebugPanel now reads events straight from
// InspectorStore, the one `onWire`-fed store.

import { makeAutoObservable } from "mobx";

const ERROR_CAP = 50;

export class LogStore {
  errors: string[] = [];

  constructor() {
    makeAutoObservable(this);
  }

  pushError(message: string): void {
    const stamp = new Date().toLocaleTimeString();
    this.errors = [`${stamp} — ${message}`, ...this.errors].slice(0, ERROR_CAP);
  }

  clearErrors(): void {
    this.errors = [];
  }
}
