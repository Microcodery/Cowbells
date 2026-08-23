import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const wasmPkg = fileURLToPath(new URL("../crates/wasm/pkg/birdeye_wasm.js", import.meta.url));

export default defineConfig({
  base: "./",
  worker: { format: "es" },
  resolve: { alias: { "birdeye-wasm": wasmPkg } },
  server: { fs: { allow: [".."] } },
  test: {
    browser: {
      enabled: true,
      provider: "playwright",
      instances: [{ browser: "chromium" }],
      headless: true,
      screenshotFailures: false,
    },
  },
});
