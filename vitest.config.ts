import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": import.meta.dirname } },
  // PGlite boots a fresh Postgres per test file; under full parallelism that can take longer
  // than vitest's 5 s default, so the limits are raised (test infra only, not app code).
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
