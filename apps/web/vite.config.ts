import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Local mode (the app talking to the 127.0.0.1 worker) is a separate build. These constants
// are replaced at build time, so the public demo build contains no worker URL or upload UI.
const local = process.env.VITE_PEBBLE_MODE === "local";

export default defineConfig({
  // Relative base + hash routing: the static demo works from any host or subpath.
  base: "./",
  plugins: [react()],
  define: {
    __PEBBLE_LOCAL__: JSON.stringify(local),
    __PEBBLE_WORKER_URL__: JSON.stringify(
      local ? (process.env.VITE_PEBBLE_WORKER_URL ?? "http://127.0.0.1:8790") : "",
    ),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
