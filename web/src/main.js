import "./style.css";

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const status = document.getElementById("status");

worker.onmessage = (e) => {
  status.textContent = e.data.type === "pong" ? e.data.msg : `error: ${e.data.message}`;
};
worker.onerror = (e) => {
  status.textContent = `error: ${e.message}`;
};
worker.postMessage({ type: "ping", msg: "worker online" });
