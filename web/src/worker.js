import init, { ping } from "birdeye-wasm";

const ready = init();

self.onmessage = async (e) => {
  try {
    await ready;
    const { type, msg } = e.data;
    if (type === "ping") {
      self.postMessage({ type: "pong", msg: ping(msg) });
    } else {
      self.postMessage({ type: "error", message: `unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err) });
  }
};
