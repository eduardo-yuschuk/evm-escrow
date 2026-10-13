import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Phase 0: there are no tests yet. Remove once the first one lands (phase 8).
    passWithNoTests: true,
  },
});
