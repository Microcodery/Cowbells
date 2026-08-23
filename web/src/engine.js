// Promise-based calls into the worker; a call may stream progress messages before its result.

export function createEngine() {
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let nextId = 1;
  let crashed = null;

  worker.onmessage = (e) => {
    const { id, result, error, progress } = e.data;
    const call = pending.get(id);
    if (!call) return;
    if (progress !== undefined) {
      call.onProgress?.(progress);
      return;
    }
    pending.delete(id);
    if (error) call.reject(new Error(error));
    else call.resolve(result);
  };
  worker.onerror = (e) => {
    crashed = new Error(`engine crashed: ${e.message}`);
    for (const { reject } of pending.values()) reject(crashed);
    pending.clear();
  };

  return {
    call(type, payload = {}, onProgress = null) {
      if (crashed) return Promise.reject(crashed);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        worker.postMessage({ id, type, ...payload });
      });
    },
  };
}
