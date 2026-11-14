import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

// Integration tests run against the real Docker infrastructure:
// Postgres (isolated wim_test database), Redis (db 1) and Mailpit.
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup-env.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
  },
});
