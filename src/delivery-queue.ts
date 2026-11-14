// src/delivery-queue.ts
// When a connector's consumer code runs: between run-to-completion steps.
//
// A connector's entry points — a transport callback, a timer, a public
// method, a promise's continuation — each run as one step: the step commits
// its whole transition, and only then do the listeners, error handlers and
// sinks it notified hear of it. A callback that calls back into the
// connector (close(), connect()) therefore never lands mid-transition.
//
// [LAW:single-enforcer] The one owner of when consumer code runs, for every
//   connector. A post outside any step is a bug, so it throws rather than
//   delivering on some second schedule.
// [LAW:no-ambient-temporal-coupling] The drain is FIFO with one drainer: a
//   step entered from inside a delivery commits its own transition and queues
//   its notifications behind the ones still waiting, so every listener hears
//   transitions in the order they were committed.

/** How an awaited promise ended. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** Where a throwing delivery's error goes. An error the reporter itself
 *  throws propagates out of the step that drained, to that step's caller. */
export type ReportError = (error: unknown) => void;

// The host's uncaught-error channel, as DOM event dispatch reports a
// listener's exception: the error surfaces on its own turn (Node's
// 'uncaughtException', a browser's 'error' event) and never reaches the entry
// point that drained, whose own caller it has nothing to do with.
const reportToHost: ReportError = (error) => {
  queueMicrotask(() => {
    throw error;
  });
};

/** Runs connector transitions as run-to-completion steps and delivers what
 *  they post to consumer code once the outermost step has committed. */
export class DeliveryQueue {
  // Pairs laid flat — [deliver, arg, deliver, arg, …] — so posting a pane
  // chunk to a sink allocates nothing per chunk once the array has grown.
  private readonly queued: unknown[] = [];
  private head = 0;
  private tail = 0;
  private depth = 0;
  private draining = false;

  // [LAW:no-silent-failure] A delivery that throws is reported, and costs
  //   the deliveries after it nothing.
  constructor(private readonly reportError: ReportError = reportToHost) {}

  /** Run one entry point's transition, `transition(arg)`. Nested steps
   *  commit inside the outermost one, which drains the queue before it
   *  returns. The argument form lets a hot path step a function bound once
   *  without a closure per call. A transition that throws is a connector
   *  fault: what it committed is still delivered, then its error
   *  propagates. */
  step<T>(transition: () => T): T;
  step<A, T>(transition: (arg: A) => T, arg: A): T;
  step<A, T>(transition: (arg?: A) => T, arg?: A): T {
    this.depth += 1;
    try {
      return transition(arg);
    } finally {
      this.depth -= 1;
      this.drainOuter();
    }
  }

  /** Run `settler` as one step once the promise `start` returns settles — or
   *  once `start` throws. Code resuming after an await is an entry point like
   *  any other, so it commits before anyone hears of it. */
  async settle<T, R>(
    start: () => Promise<T>,
    settler: (outcome: Outcome<T>) => R,
  ): Promise<R> {
    let outcome: Outcome<T>;
    try {
      outcome = { ok: true, value: await start() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    return this.step(settler, outcome);
  }

  /** Queue `deliver(arg)`, a call into consumer code, for delivery after the
   *  current step. */
  post<A>(deliver: (arg: A) => void, arg: A): void {
    if (this.depth === 0) {
      throw new Error("DeliveryQueue.post outside a step");
    }
    this.queued[this.tail] = deliver;
    this.queued[this.tail + 1] = arg;
    this.tail += 2;
  }

  private drainOuter(): void {
    // A nested step leaves its posts to the outermost; a step entered from a
    // delivery leaves them to the drain already running.
    if (this.depth > 0 || this.draining) return;
    this.draining = true;
    // A reporter that throws ends this drain, never the queue: the deliveries
    // still waiting go out with the next step.
    try {
      while (this.head < this.tail) {
        const deliver = this.queued[this.head] as (arg: unknown) => void;
        const arg = this.queued[this.head + 1];
        // Delivered slots hold nothing, so a drained queue retains no chunk.
        this.queued[this.head] = undefined;
        this.queued[this.head + 1] = undefined;
        this.head += 2;
        try {
          deliver(arg);
        } catch (error) {
          this.reportError(error);
        }
        // Caught up: rewind, so a drain kept busy by the steps its deliveries
        // enter reuses its slots rather than growing the array.
        if (this.head === this.tail) {
          this.head = 0;
          this.tail = 0;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
