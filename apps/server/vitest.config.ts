import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@lastthaw/shared": path.resolve(here, "../../packages/shared/src/index.ts") },
  },
  // One file at a time: every test shares the local database, and the job runner touches every running match.
  test: { environment: "node", env: { LOG_LEVEL: "silent" }, testTimeout: 60_000, fileParallelism: false },
});
