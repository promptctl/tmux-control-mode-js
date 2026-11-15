// src/window-terminal/engine/deliver.ts
//
// How the window terminal calls a host's listener.
//
// [LAW:single-enforcer] Every host-facing listener set (the engine's state
//   and error listeners, the terminal's error listeners) is called through
//   `deliver`: a listener's throw is the host's bug, not the window's. It
//   reaches the page as an uncaught error, as a DOM event listener's does,
//   and the caller and the other listeners carry on.

// Every host the window terminal runs in (browsers, Node, Deno, Bun) has it;
// the engine's lib carries neither DOM nor Node types.
declare const queueMicrotask: (cb: () => void) => void;

export type Listener<T> = (value: T) => void;

export function deliver<T>(listeners: Iterable<Listener<T>>, value: T): void {
  for (const cb of listeners) {
    try {
      cb(value);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }
}
