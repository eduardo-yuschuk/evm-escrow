import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests start Anvil, deploy and index: well beyond the 5 s default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
