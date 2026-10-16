import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@lastthaw/shared": path.resolve(here, "../../packages/shared/src/index.ts") },
  },
  // One file at a time: every test shares the local database, and the job runner touches every running match.
  // The complete-game run (test/fullGame.test.ts) is slow and only matters for game-logic changes:
  // `npm test` skips it, `npm run test:game` runs it alone, and CI runs both.
  test: { environment: "node", env: { LOG_LEVEL: "silent" }, testTimeout: 60_000, fileParallelism: false, setupFiles: ["./test/setup.ts"], exclude: process.env.FULL_GAME ? ["**/node_modules/**"] : ["**/node_modules/**", "**/fullGame.test.ts"], ...(process.env.FULL_GAME ? { include: ["test/fullGame.test.ts"] } : {}) },
});
