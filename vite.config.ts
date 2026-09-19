import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import gabrielViewer from "./gabriel/ui/vite.config";

// Reuse Gabriel's committed read-only /api/runs and /api/graph middleware.
// Simulation execution remains in gabriel/src/run.ts, outside the browser.
const runsApi = gabrielViewer.plugins?.find(
  (plugin) =>
    plugin &&
    typeof plugin === "object" &&
    "name" in plugin &&
    plugin.name === "runs-api",
);
if (!runsApi)
  throw new Error("Gabriel no exporta el middleware runs-api esperado.");
export default defineConfig({
  plugins: [react(), runsApi],
  server: { host: "127.0.0.1", port: 5173 },
});
