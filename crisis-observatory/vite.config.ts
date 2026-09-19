import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { runsApi } from "./server/runsApi";

// Serve activity records through /api/runs and /api/graph.
// The engine runs in gabriel/src/run.ts, outside the browser.
export default defineConfig({
  plugins: [react(), runsApi()],
  server: { host: "127.0.0.1", port: 5173 },
});
