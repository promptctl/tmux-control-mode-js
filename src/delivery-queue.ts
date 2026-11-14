// src/delivery-queue.ts
// When a connector's consumer code runs: between run-to-completion steps.
//
// A connector's entry points — a transport callback, a timer, a public
// method — each run as one step: the step commits its whole transition, and
// only then do the listeners, error handlers and sinks it notified hear of
// it. A listener that calls back into the connector (close(), connect())
// therefore never lands mid-transition, and nothing the connector does after
// a delivery reads state a callback could have changed.
//
// [LAW:single-enforcer] The one owner of when consumer code runs, for every
//   connector. A post outside any step is a bug, so it throws rather than
//   delivering on some second schedule.
// [LAW:no-ambient-temporal-coupling] The drain is FIFO with one drainer: a
//   step entered from inside a delivery commits its own transition and queues
//   its notifications behind the ones still waiting, so every listener hears
//   transitions in the order they were committed.

/** How a step's transition or an awaited promise ended. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

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
  // The errors of the batch running now, if one is.
  private batchErrors: unknown[] | undefined;

  /** Run one entry point's transition, `transition(arg)`. Nested steps
   *  commit inside the outermost one, which drains the queue before it
   *  returns. The argument form lets a hot path step a method bound once
   *  without a closure per call. */
  step<T>(transition: () => T): T;
  step<A, T>(transition: (arg: A) => T, arg: A): T;
  step<A, T>(transition: (arg?: A) => T, arg?: A): T {
    this.depth += 1;
    let value: T;
    try {
      value = transition(arg);
    } catch (error) {
      this.depth -= 1;
      // What the transition committed before it threw is still announced;
      // its own error comes first.
      throw combined([error, ...this.drainOuter()]);
    }
    this.depth -= 1;
    const errors = this.drainOuter();
    if (errors.length === 0) return value;
    if (this.batchErrors === undefined) throw combined(errors);
    this.batchErrors.push(...errors);
    return value;
  }

  /** Run `arrival(arg)`: entry points that arrive together, as the messages
   *  of one transport read do, each stepping on its own so each is heard
   *  before the next commits. A step whose deliveries throw does not cost
   *  the steps after it theirs: every error leaves together once the batch
   *  has run. */
  batch<A>(arrival: (arg: A) => void, arg: A): void {
    const outer = this.batchErrors;
    const errors: unknown[] = [];
    this.batchErrors = errors;
    try {
      arrival(arg);
    } catch (error) {
      errors.push(error);
    } finally {
      this.batchErrors = outer;
    }
    if (errors.length > 0) throw combined(errors);
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
    return this.step(() => settler(outcome));
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

  // [LAW:no-silent-failure] A throwing delivery does not cost the others
  //   theirs: the drain finishes, and every error it caught leaves through the
  //   entry point that drained — not only the first.
  private drainOuter(): readonly unknown[] {
    // A nested step leaves its posts to the outermost; a step entered from a
    // delivery leaves them to the drain already running.
    if (this.depth > 0 || this.draining) return NO_ERRORS;
    this.draining = true;
    let errors: unknown[] | undefined;
    while (this.head < this.tail) {
      const deliver = this.queued[this.head] as (arg: unknown) => void;
      const arg = this.queued[this.head + 1];
      // Delivered slots hold nothing, so a drained queue retains no chunk.
      this.queued[this.head] = undefined;
      this.queued[this.head + 1] = undefined;
      this.head += 2;
      try {
        deliver(arg);
      } catch (err) {
        (errors ??= []).push(err);
      }
    }
    this.head = 0;
    this.tail = 0;
    this.draining = false;
    return errors ?? NO_ERRORS;
  }
}

const NO_ERRORS: readonly unknown[] = [];

function combined(errors: readonly unknown[]): unknown {
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, `${errors.length} errors in one step`);
}
