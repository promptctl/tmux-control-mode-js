// examples/web-multiplexer/electron/wrapper-tracker.ts
// Pure helper that owns the listener-wrapper bookkeeping for the preload's
// `on` / `removeListener` exposure on tmuxIpc.
//
// Why this exists: the preload installs a stable closure on `ipcRenderer.on`
// that forwards `(event, ...args)` to the caller-supplied listener — the
// wrapper preserves the `IpcRendererLike.on` contract verbatim, it does NOT
// strip the event. The wrapper is needed for *identity*: contextBridge
// proxies functions across the context-isolation boundary, and the
// caller-supplied listener doesn't survive the round-trip with a stable
// reference, so we cannot pass it directly to `ipcRenderer.on` and then
// expect `ipcRenderer.removeListener` to find it later. The wrapper is a
// stable closure on the preload side that we hand to both calls.
//
// One bookkeeping slot PER `on()` call, scoped by channel:
// Map<channel, Map<listener, wrapper[]>>. removeListener pops LIFO to
// mirror Node's EventEmitter "remove one binding per call" contract.
//
// [LAW:one-source-of-truth] One place owns the listener→wrappers mapping;
// the preload calls into it from `on` and `removeListener`.
// [LAW:single-enforcer] All bookkeeping mutations (add, remove, prune-empty)
// live here; the preload never touches the maps directly.

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
