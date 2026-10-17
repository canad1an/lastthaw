import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

/**
 * Phone layout tests: the match page on real phone profiles (Safari's engine for the iPhones,
 * Chromium for the Pixel), against the local API and web dev servers. One worker: the servers
 * and the database are shared.
 */
export default defineConfig({
  testDir: "./test",
  timeout: 300_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "iphone-13", use: { ...devices["iPhone 13"] } },
    { name: "iphone-se", use: { ...devices["iPhone SE"] } },
    { name: "pixel-7", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "npm run dev:api",
      cwd: root,
      url: "http://localhost:3000/api/health",
      reuseExistingServer: true,
      timeout: 120_000,
      env: { DEV_TOOLS: "true", LOG_LEVEL: "warn" },
    },
    {
      command: "npm run dev:web",
      cwd: root,
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
