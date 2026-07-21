import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/managed/**/*.test.ts"],
    env: { MCP_TESTING: "1" },
  },
});
