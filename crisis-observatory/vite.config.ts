import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { runsApi } from "./server/runsApi";

// Serve activity records through /api/runs and /api/graph.
// The simulator runs in ../backend (npm run sim), outside the browser.
export default defineConfig({
  optimizeDeps: { include: ["@huggingface/transformers"] },
  plugins: [react(), runsApi()],
  server: {
    host: "127.0.0.1", port: 5173,
    // Dependencies may be installed at the repository root, including the local font files.
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
});
