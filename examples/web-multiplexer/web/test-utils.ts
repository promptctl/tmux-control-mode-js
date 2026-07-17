// examples/web-multiplexer/web/test-utils.ts
//
// [LAW:one-source-of-truth] Shared async-test primitives. `deferred` and `tick`
// are the concurrency-control tools every store test uses to drive a promise's
// settlement by hand and flush microtasks; they live here once so a change to
// their assumptions can't drift between test files.

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

/** A promise plus its resolve/reject, so a test settles it on its own schedule. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield to the microtask/timer queue so settled promises' `.then`s run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
