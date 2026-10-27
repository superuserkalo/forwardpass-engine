// Bound network fan-out globally and per origin without creating hundreds of promises.
export async function mapOrigins<T, R>(items: readonly T[], origin: (item: T) => string, run: (item: T) => Promise<R>, concurrency = 8, perOrigin = 2): Promise<R[]> {
  const pending = items.map((item, index) => ({ item, index }));
  const active = new Map<string, number>();
  const output = new Array<R>(items.length);
  return new Promise((resolve, reject) => {
    let running = 0;
    let failed = false;
    const pump = () => {
      if (failed) return;
      while (running < concurrency) {
        const pos = pending.findIndex(({ item }) => (active.get(origin(item)) || 0) < perOrigin);
        if (pos < 0) break;
        const { item, index } = pending.splice(pos, 1)[0];
        const key = origin(item);
        active.set(key, (active.get(key) || 0) + 1); running++;
        run(item).then((result) => {
          output[index] = result;
          running--; active.set(key, (active.get(key) || 1) - 1);
          if (!pending.length && !running) resolve(output); else pump();
        }, (error: unknown) => { failed = true; reject(error); });
      }
      if (!pending.length && !running) resolve(output);
    };
    pump();
  });
}

// Hold the slot through the entire operation, including response-body consumption.
// A failed request still observes the delay before the next request may start.
export function createPacedRunner(intervalMs: number) {
  let pending: Promise<void> = Promise.resolve();
  let nextAllowedAt = 0;
  return function runPaced<T>(run: () => Promise<T>): Promise<T> {
    const result = pending.then(async () => {
      const delay = nextAllowedAt - Date.now();
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      try {
        return await run();
      } finally {
        nextAllowedAt = Date.now() + intervalMs;
      }
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
}
