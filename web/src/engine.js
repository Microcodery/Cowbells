// Promise-based calls into the worker.

export function createEngine() {
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let nextId = 1;
  let crashed = null;

  worker.onmessage = (e) => {
    const { id, result, error } = e.data;
    const { resolve, reject } = pending.get(id) ?? {};
    pending.delete(id);
    if (error) reject?.(new Error(error));
    else resolve?.(result);
  };
  worker.onerror = (e) => {
    crashed = new Error(`engine crashed: ${e.message}`);
    for (const { reject } of pending.values()) reject(crashed);
    pending.clear();
  };

  return {
    call(type, payload = {}) {
      if (crashed) return Promise.reject(crashed);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, type, ...payload });
      });
    },
  };
}
