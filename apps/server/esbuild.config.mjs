import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// Bundle our own code (including the @lastthaw/shared TypeScript source) and
// leave every real npm dependency external so native modules keep working.
await build({
  entryPoints: ["src/api/index.ts", "src/worker/index.ts", "src/db/migrate.ts"],
  outdir: "dist",
  outbase: "src",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "external",
  alias: {
    "@lastthaw/shared": path.join(here, "../../packages/shared/src/index.ts"),
  },
  logLevel: "info",
});
