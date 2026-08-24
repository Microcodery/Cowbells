import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const wasmPkg = fileURLToPath(new URL("../crates/wasm/pkg/cowbells_wasm.js", import.meta.url));

export default defineConfig({
  base: "./",
  // Our worker and MapLibre's are ES modules.
  worker: { format: "es" },
  resolve: { alias: { "cowbells-wasm": wasmPkg } },
  // MapLibre is most of the bundle and changes rarely; its own chunk caches separately. It is
  // ~950 kB minified on its own, so the size warning is raised just above it.
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: { output: { manualChunks: { maplibre: ["maplibre-gl"] } } },
  },
  server: { fs: { allow: [".."] } },
  test: {
    browser: {
      enabled: true,
      provider: "playwright",
      instances: [{ browser: "chromium", launch: { channel: "chromium" } }],
      headless: true,
      screenshotFailures: false,
    },
  },
});
