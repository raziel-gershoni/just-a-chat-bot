// Counts in-flight webhook handlers, so a graceful shutdown waits for them before the process
// exits (an update cut off mid-handle would otherwise wait for Telegram's redelivery).
export type Inflight = {
  /** Runs `fn`, counted as in flight until it settles. */
  track<T>(fn: () => Promise<T>): Promise<T>;
  /** Resolves once nothing is in flight. */
  idle(): Promise<void>;
  count(): number;
};

export function createInflight(): Inflight {
  let n = 0;
  let waiters: (() => void)[] = [];
  const settle = () => {
    n -= 1;
    if (n > 0) return;
    const ready = waiters;
    waiters = [];
    for (const w of ready) w();
  };
  return {
    async track(fn) {
      n += 1;
      try {
        return await fn();
      } finally {
        settle();
      }
    },
    idle: () => (n === 0 ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
    count: () => n,
  };
}
