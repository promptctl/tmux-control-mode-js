// src/connectors/electron/wrapper-tracker.ts
// Pure helper that owns the listener-wrapper bookkeeping for Electron
// preloads exposing an `on` / `removeListener` surface across the
// contextBridge boundary.
//
// Why this exists: a preload that re-exposes `ipcRenderer.on` to a sandboxed
// renderer must install a stable closure on the preload side that forwards
// `(event, ...args)` to the caller-supplied listener. The wrapper is needed
// for *identity*: contextBridge proxies functions across the
// context-isolation boundary, and the caller-supplied listener does not
// survive the round-trip with a stable reference, so the preload cannot pass
// it to `ipcRenderer.on` and then expect `ipcRenderer.removeListener` to
// match it later. The wrapper is a stable preload-side closure handed to
// both calls.
//
// One bookkeeping slot PER `on()` call, scoped by channel:
// Map<channel, Map<listener, wrapper[]>>. removeListener pops LIFO to mirror
// Node's EventEmitter "remove one binding per call" contract.
//
// [LAW:single-enforcer] Sole owner of bridge-listener lifecycle. Every
// Electron preload that re-exposes `on`/`removeListener` for the bridge
// channels delegates here; no callsite touches the maps directly. Adding a
// second tracker is a bug — the listener identity invariant must be enforced
// in exactly one place.
// [LAW:one-source-of-truth] One place owns the listener→wrappers mapping;
// the preload calls into it from `on` and `removeListener`.

export interface WrapperTracker<L, W> {
  add(channel: string, listener: L, wrapper: W): void;
  remove(channel: string, listener: L): W | null;
  size(channel: string, listener: L): number;
}

export function createWrapperTracker<
  L extends object,
  W,
>(): WrapperTracker<L, W> {
  const byChannel = new Map<string, Map<L, W[]>>();

  const channelMap = (channel: string): Map<L, W[]> => {
    const existing = byChannel.get(channel);
    if (existing !== undefined) return existing;
    const fresh = new Map<L, W[]>();
    byChannel.set(channel, fresh);
    return fresh;
  };

  return {
    add(channel, listener, wrapper) {
      const map = channelMap(channel);
      const arr = map.get(listener);
      if (arr === undefined) {
        map.set(listener, [wrapper]);
        return;
      }
      arr.push(wrapper);
    },

    remove(channel, listener) {
      const map = byChannel.get(channel);
      if (map === undefined) return null;
      const arr = map.get(listener);
      if (arr === undefined || arr.length === 0) return null;
      const wrapper = arr.pop()!;
      if (arr.length === 0) {
        map.delete(listener);
        if (map.size === 0) byChannel.delete(channel);
      }
      return wrapper;
    },

    size(channel, listener) {
      return byChannel.get(channel)?.get(listener)?.length ?? 0;
    },
  };
}
