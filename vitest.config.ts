import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["gabriel/test/**/*.test.ts"] },
});
