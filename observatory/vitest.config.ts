import { defineConfig } from "vitest/config";

// The simulator's tests. The Control Center's own run on node:test (npm test).
export default defineConfig({
  test: { include: ["tests/engine/*.test.ts"] },
});
