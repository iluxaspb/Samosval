// Share only an unfinished identical read. No TTL, retained results or write deduplication.
export function readFlight(scope) {
  const pending = new Map();
  return {
    run(key, load) {
      const scopedKey = JSON.stringify([scope(), key]);
      const existing = pending.get(scopedKey);
      if (existing) return existing;
      const task = Promise.resolve().then(load);
      pending.set(scopedKey, task);
      const clear = () => {
        if (pending.get(scopedKey) === task) pending.delete(scopedKey);
      };
      task.then(clear, clear);
      return task;
    },
    invalidate() {
      pending.clear();
    },
  };
}
