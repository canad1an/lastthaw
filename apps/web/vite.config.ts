import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 0.<commits on main>: set by the image build on deploy, read from git when developing. */
function appVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  try {
    return `0.${execSync("git rev-list --count HEAD", { cwd: here, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()}`;
  } catch {
    return "0.0";
  }
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@lastthaw/shared": path.resolve(here, "../../packages/shared/src/index.ts") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", ws: true },
    },
  },
});
