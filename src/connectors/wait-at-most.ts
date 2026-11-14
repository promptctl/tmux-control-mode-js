// src/connectors/wait-at-most.ts
// [LAW:single-enforcer] The one "wait for this, but no longer than that" race
// the bridges' drains share: it settles when `work` does or when `ms` elapses,
// whichever comes first, and leaves no timer behind either way. The timer is
// unref'd: a bound on waiting is never the thing that keeps a process alive.

export async function waitAtMost(
  work: Promise<unknown>,
  ms: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([work, elapsed]);
  } finally {
    clearTimeout(timer);
  }
}
