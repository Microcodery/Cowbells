import { describe, expect, it } from "vitest";

function ask(worker, message) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => reject(e);
    worker.postMessage(message);
  });
}

describe("worker", () => {
  it("round-trips a ping through the WASM engine", async () => {
    const worker = new Worker(new URL("../src/worker.js", import.meta.url), { type: "module" });
    const reply = await ask(worker, { type: "ping", msg: "hello" });
    expect(reply.type, reply.message).toBe("pong");
    expect(reply.msg).toMatch(/^birdeye \d+\.\d+\.\d+: hello$/);
    worker.terminate();
  });
});
