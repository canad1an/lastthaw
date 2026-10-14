/**
 * Early-game pacing simulator: a solo player on an average plains capital at 1x,
 * greedily doing the next affordable action from a sensible opening order.
 * Prints when each action becomes affordable. Run: npx tsx tools/mapgen/src/pace.ts
 */
import {
  balance,
  buildingById,
  buildingCost,
  buildingSeconds,
  effectsOf,
  settle,
  startingEconomy,
  techById,
  techSeconds,
  type Cost,
  type RegionEconomy,
  type RegionTraits,
} from "@lastthaw/shared";

const traits: RegionTraits = { terrain: "plains", resources: ["fertile_soil"], coastal: false, river: false };
const ORDER: Array<["b" | "t", string]> = [
  ["t", "fire_making"], ["b", "huts"], ["b", "hunting_grounds"], ["b", "lumber_camp"], ["t", "flint_tools"], ["b", "storehouse"],
  ["b", "quarry"], ["t", "agriculture"], ["b", "huts"], ["b", "hunting_grounds"], ["t", "animal_husbandry"], ["b", "lumber_camp"],
  ["b", "quarry"], ["b", "huts"], ["b", "storehouse"], ["t", "bronze_working"], ["b", "farm"], ["b", "hunting_grounds"], ["b", "huts"],
  ["b", "lumber_camp"], ["t", "mining"], ["b", "mine"], ["b", "quarry"], ["b", "huts"], ["b", "granary"], ["t", "writing"], ["b", "farm"],
];

let e: RegionEconomy = startingEconomy();
const buildings: Record<string, number> = {};
const techs = new Set<string>();
let t = 0; // real seconds at 1x
const step = 30;
const done: Array<{ t: number; what: string }> = [];
let queueFreeAt = 0;
let researchFreeAt = 0;

function apply(e: RegionEconomy): RegionEconomy {
  const f = effectsOf(buildings);
  const base = balance.economy.baseStorage;
  return { ...e, capacity: balance.economy.baseCapacity + f.capacity, storage: { food: base.food * f.storage, wood: base.wood * f.storage, stone: base.stone * f.storage }, yieldMult: f.yield, extract: f.extract };
}
function afford(c: Cost) {
  return (c.food ?? 0) <= e.food && (c.wood ?? 0) <= e.wood && (c.stone ?? 0) <= e.stone && !c.copper && !c.tin && !c.iron;
}
function pay(c: Cost) {
  e = { ...e, food: e.food - (c.food ?? 0), wood: e.wood - (c.wood ?? 0), stone: e.stone - (c.stone ?? 0) };
}

let idx = 0;
while (t <= 3 * 3600 && idx < ORDER.length) {
  const [kind, id] = ORDER[idx]!;
  let acted = false;
  if (kind === "b") {
    const def = buildingById.get(id)!;
    const level = (buildings[id] ?? 0) + 1;
    const cost = buildingCost(def, level);
    if (afford(cost) && t >= queueFreeAt) {
      pay(cost);
      buildings[id] = level; // effect applied immediately (simplification)
      queueFreeAt = t + buildingSeconds(def, level);
      done.push({ t, what: `${def.name} L${level} (${Math.round(buildingSeconds(def, level) / 60)}m)` });
      acted = true;
    }
  } else {
    const def = techById.get(id)!;
    const ok = (def.requires ?? []).every((r) => techs.has(r));
    if (ok && afford(def.cost) && t >= researchFreeAt) {
      pay(def.cost);
      techs.add(id);
      researchFreeAt = t + techSeconds(def);
      done.push({ t, what: `${def.name} (${Math.round(techSeconds(def) / 60)}m)` });
      acted = true;
    }
  }
  if (acted) {
    idx += 1;
    e = apply(e);
    continue;
  }
  e = settle(traits, apply(e), step, 1);
  t += step;
}
for (const d of done) console.log(`${String(Math.round(d.t / 60)).padStart(4)}m  ${d.what}`);
console.log(`\nby 10m: ${done.filter((d) => d.t <= 600).length}  by 1h: ${done.filter((d) => d.t <= 3600).length}  by 3h: ${done.filter((d) => d.t <= 10800).length}`);
console.log(`pop ${e.popWorkers.toFixed(1)}/${e.capacity}  food ${e.food.toFixed(0)}/${e.storage.food}  wood ${e.wood.toFixed(0)}  stone ${e.stone.toFixed(0)} at ${Math.round(t / 60)}m`);
