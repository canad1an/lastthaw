import fs from "node:fs";
const w = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
function verts(d) {
  const out = []; const re = /([MLHVZmlhvz])|(-?\d*\.?\d+)/g; let cmd = "", x = 0, y = 0, nums = [], m;
  const flush = () => { while (nums.length) {
    if (cmd === "M" || cmd === "L") { x = nums.shift(); y = nums.shift(); out.push([x, y]); if (cmd === "M") cmd = "L"; }
    else if (cmd === "H") { x = nums.shift(); out.push([x, y]); } else if (cmd === "V") { y = nums.shift(); out.push([x, y]); } else nums.length = 0; } };
  while ((m = re.exec(d))) { if (m[1]) { flush(); cmd = m[1]; } else nums.push(Number(m[2])); }
  flush(); return out;
}
const key = ([x, y]) => `${Math.round(x * 2) / 2},${Math.round(y * 2) / 2}`;
const V = new Map(w.regions.map((r) => [r.id, verts(r.path)]));
const K = new Map(w.regions.map((r) => [r.id, new Set(V.get(r.id).map(key))]));
const out = {};
for (const r of w.regions) {
  if (!r.coastal) continue;
  const nb = new Set(); for (const n of r.neighbors) for (const k of K.get(n)) nb.add(k);
  const lonely = V.get(r.id).filter((v) => !nb.has(key(v)));
  if (lonely.length === 0) continue;
  // The coast point: the lonely vertex nearest the mean of all lonely vertices, so it sits mid-shore and on the outline.
  const mx = lonely.reduce((a, v) => a + v[0], 0) / lonely.length, my = lonely.reduce((a, v) => a + v[1], 0) / lonely.length;
  let best = lonely[0], bd = Infinity;
  for (const v of lonely) { const d = Math.hypot(v[0] - mx, v[1] - my); if (d < bd) { bd = d; best = v; } }
  // Which way is the water: away from the region's centroid.
  const ang = Math.atan2(best[1] - r.y, best[0] - r.x);
  out[r.id] = { x: Math.round(best[0] * 10) / 10, y: Math.round(best[1] * 10) / 10, a: Math.round((ang * 180) / Math.PI) };
}
fs.writeFileSync(process.argv[3], JSON.stringify(out));
console.log(Object.keys(out).length, "coast points of", w.regions.filter((r) => r.coastal).length, "coastal regions");
