/**
 * Regenerates the lists of illustrated pictures the web app has: every png under apps/web/public/units becomes
 * UNIT_PICTURES and every png under apps/web/public/buildings becomes BUILDING_PICTURES.
 * Run: node tools/unit-pictures/list-pictures.mjs
 */
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sets = [
  { folder: "units", name: "UNIT_PICTURES", file: "unitPictures.ts", what: "Units" },
  { folder: "buildings", name: "BUILDING_PICTURES", file: "buildingPictures.ts", what: "Buildings" },
];
for (const { folder, name, file, what } of sets) {
  const ids = readdirSync(path.join(ROOT, "apps", "web", "public", folder))
    .filter((f) => f.endsWith(".png"))
    .map((f) => f.slice(0, -4))
    .sort();
  const src = `/** ${what} with an illustrated picture under /${folder}/<id>.png (generated list: every png in apps/web/public/${folder}). */\nexport const ${name}: ReadonlySet<string> = new Set(${JSON.stringify(ids)});\n`;
  writeFileSync(path.join(ROOT, "apps", "web", "src", "components", file), src);
  console.log(`${file}: ${ids.length} pictures`);
}
