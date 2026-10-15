import { BUILDINGS, UNITS, balance, computeRates, effectsOf, regionById, storageCaps, techById, type BuildingDef, type RegionEconomy, type TechDef, type UnitDef, AGES } from "@lastthaw/shared";
import type { Delta } from "./Tooltip.js";
import { fmt, signed } from "./ui.js";

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Before → after rows for upgrading `def` to `level` in a region whose
 * buildings and live economy are given. Everything is computed with the same
 * rules the server uses, so the numbers are exact.
 */
export function buildingPreview(def: BuildingDef, level: number, buildings: Record<string, number>, economy: RegionEconomy, regionId: string, speed: number, capital = false): { summary: string; rows: Delta[] } {
  const region = regionById(regionId)!;
  const traits = { terrain: region.terrain, resources: region.resources, coastal: region.coastal, river: region.river };
  const before = effectsOf(buildings);
  const after = effectsOf({ ...buildings, [def.id]: level });
  const withEffects = (f: typeof before): RegionEconomy => ({
    ...economy,
    capacity: balance.economy.baseCapacity + f.capacity,
    storage: storageCaps(f, capital),
    yieldMult: f.yield,
    extract: f.extract,
    iceFactor: economy.iceFactor,
    growthMult: economy.growthMult,
    abandoned: economy.abandoned,
  });
  const rb = computeRates(traits, withEffects(before));
  const ra = computeRates(traits, withEffects(after));
  const rows: Delta[] = [];
  const perHour = (v: number) => `${signed(v * speed, 1)}/h`;
  const e = def.effect;

  if (e.capacity) rows.push({ label: "People capacity", before: fmt(balance.economy.baseCapacity + before.capacity), after: fmt(balance.economy.baseCapacity + after.capacity), tone: "up" });
  if (e.yield?.food || e.capacity) rows.push({ label: "Food", before: perHour(rb.food), after: perHour(ra.food), tone: ra.food >= rb.food ? "up" : "down" });
  if (e.yield?.wood) rows.push({ label: "Wood", before: perHour(rb.wood), after: perHour(ra.wood), tone: "up" });
  if (e.yield?.stone) rows.push({ label: "Stone", before: perHour(rb.stone), after: perHour(ra.stone), tone: "up" });
  if (e.storage || e.foodStorage) {
    const cb = storageCaps(before, capital);
    const ca = storageCaps(after, capital);
    rows.push({ label: "Food storage", before: fmt(cb.food), after: fmt(ca.food), tone: "up" });
    if (e.storage) {
      rows.push({ label: "Wood storage", before: fmt(cb.wood), after: fmt(ca.wood), tone: "up" });
      rows.push({ label: "Stone storage", before: fmt(cb.stone), after: fmt(ca.stone), tone: "up" });
    }
  }
  if (e.protect) rows.push({ label: "Safe from raids (each)", before: fmt(before.protect), after: fmt(after.protect), tone: "up" });
  if (e.extract) {
    for (const [k, v] of Object.entries(e.extract)) {
      if (!v || !(region.resources as readonly string[]).includes(k)) continue;
      rows.push({ label: `${k[0]!.toUpperCase()}${k.slice(1)}`, before: perHour(rb.special[k as keyof typeof rb.special] ?? 0), after: perHour(ra.special[k as keyof typeof ra.special] ?? 0), tone: "up" });
    }
    if (rows.every((r) => !Object.keys(e.extract!).some((k) => r.label.toLowerCase() === k))) {
      rows.push({ label: "Extracts", before: "nothing here", after: `needs ${Object.keys(e.extract).join("/")} in the region` });
    }
  }
  if (e.defense) rows.push({ label: "Defence bonus", before: `+${pct(before.defense)}`, after: `+${pct(after.defense)}`, tone: "up" });
  if (e.loyalty) rows.push({ label: "Loyalty bonus", before: `+${pct(before.loyalty)}`, after: `+${pct(after.loyalty)}`, tone: "up" });
  if (e.trainSpeed) rows.push({ label: "Training speed", before: `+${pct(before.trainSpeed)}`, after: `+${pct(after.trainSpeed)}`, tone: "up" });
  if (e.researchSpeed) rows.push({ label: "Research speed", before: `+${pct(before.researchSpeed)}`, after: `+${pct(after.researchSpeed)}`, tone: "up" });
  if (def.perNeighbor) rows.push({ label: "Connects to", before: "", after: `${region.neighbors.length} neighbouring regions`, tone: "up" });
  if (e.harbor) rows.push({ label: "Sea legs", before: "", after: `${Math.round((1 - balance.travel.harborBothFactor) * 100)}% faster to another harbour, ${Math.round((1 - balance.travel.harborOneFactor) * 100)}% faster to open coast`, tone: "up" });
  if (def.perNeighbor) rows.push({ label: "Travel on road legs", before: "", after: `${Math.round((1 - balance.travel.roadBothFactor) * 100)}% faster (both ends), ${Math.round((1 - balance.travel.roadOneFactor) * 100)}% (one end)`, tone: "up" });
  if (e.harbor) rows.push({ label: "Sea routes", before: before.harbor ? "yes" : "no", after: "yes", tone: "up" });

  const summary = describeBuilding(def);
  return { summary, rows };
}

function describeBuilding(def: BuildingDef): string {
  const parts: string[] = [def.description];
  const e = def.effect;
  const per: string[] = [];
  if (e.capacity) per.push(`+${e.capacity} people capacity`);
  if (e.yield?.food) per.push(`+${pct(e.yield.food)} food`);
  if (e.yield?.wood) per.push(`+${pct(e.yield.wood)} wood`);
  if (e.yield?.stone) per.push(`+${pct(e.yield.stone)} stone`);
  if (e.storage) per.push(`+${pct(e.storage)} storage`);
  if (e.foodStorage) per.push(`+${pct(e.foodStorage)} food storage`);
  if (e.protect) per.push(`${e.protect} of each resource hidden from raiders`);
  if (e.extract) per.push(`extracts ${Object.entries(e.extract).map(([k, v]) => `${v} ${k}/h`).join(", ")} where available`);
  if (e.defense) per.push(`+${pct(e.defense)} defence`);
  if (e.loyalty) per.push(`+${pct(e.loyalty)} loyalty`);
  if (e.trainSpeed) per.push(`+${pct(e.trainSpeed)} training speed`);
  if (e.researchSpeed) per.push(`+${pct(e.researchSpeed)} research speed`);
  if (e.harbor) per.push("lets armies use sea routes");
  if (per.length) parts.push(`Per level: ${per.join(", ")}. Max level ${def.maxLevel}.`);
  return parts.join(" ");
}

export function unitPreview(def: UnitDef): { summary: string; rows: Delta[] } {
  const kmh = def.speed * balance.travel.speedScale;
  const rows: Delta[] = [
    { label: "Attack", before: "", after: String(def.attack) },
    { label: "Defence", before: "", after: String(def.defense) },
    { label: "Speed", before: "", after: `${kmh} km per game hour` },
    { label: "Carries", before: "", after: `${def.carry} loot` },
  ];
  const needs = [def.requires ? `needs ${techById.get(def.requires)?.name ?? def.requires}` : null, def.needsResource ? `trained only where there are ${def.needsResource}` : null].filter(Boolean).join("; ");
  return { summary: `${def.description} Each unit takes one worker out of the fields.${needs ? ` ${needs[0]!.toUpperCase()}${needs.slice(1)}.` : ""}`, rows };
}

export function techPreview(def: TechDef): { summary: string; unlocks: string[] } {
  const unlocks: string[] = [];
  for (const b of BUILDINGS) if (b.requires === def.id) unlocks.push(`${b.name} (building)`);
  for (const u of UNITS) if (u.requires === def.id && !u.hidden) unlocks.push(`${u.name} (unit)`);
  if (def.advancesTo !== undefined) unlocks.push(`advance to the ${AGES[def.advancesTo]} Age: all its buildings, units and techs${def.earliestDay !== undefined ? ` (from day ${def.earliestDay + 1})` : ""}`);
  if (def.id === balance.travel.seaTech) unlocks.push("armies may cross sea routes");
  const carry = balance.trade.caravanCarryTechs[def.id];
  if (carry) unlocks.push(`caravans carry ${Math.round(carry * 100)}% more`);
  const fx = def.effect;
  if (fx) {
    const p = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`;
    if (fx.yield?.food) unlocks.push(`food ${p(fx.yield.food)} in every region`);
    if (fx.yield?.wood) unlocks.push(`wood ${p(fx.yield.wood)} in every region`);
    if (fx.yield?.stone) unlocks.push(`stone ${p(fx.yield.stone)} in every region`);
    if (fx.capacity) unlocks.push(`+${fx.capacity} people capacity in every region`);
    if (fx.storage) unlocks.push(`storage ${p(fx.storage)}`);
    if (fx.growth) unlocks.push(`population growth ${p(fx.growth)}`);
    if (fx.extract) unlocks.push(`ore and horse extraction ${p(fx.extract)}`);
    if (fx.attack) unlocks.push(`attack ${p(fx.attack)}`);
    if (fx.defense) unlocks.push(`defence ${p(fx.defense)}`);
    if (fx.trainSpeed) unlocks.push(`training ${p(fx.trainSpeed)} faster`);
    if (fx.researchSpeed) unlocks.push(`research ${p(fx.researchSpeed)} faster`);
    if (fx.travel) unlocks.push(`armies and caravans ${p(fx.travel)} faster`);
    if (fx.loyalty) unlocks.push(`loyalty ${p(fx.loyalty)} in every region`);
    if (fx.vision) unlocks.push(fx.vision >= 99 ? "live sight of the whole map" : `live sight ${fx.vision} hops beyond your borders`);
  }
  const metals = Object.keys(def.cost).filter((k) => k === "copper" || k === "tin" || k === "iron" || k === "horses");
  const note = metals.length ? ` Costs ${metals.join(" and ")}: these come from a Mine or Stables on a region that has them, from raids, or from the market.` : "";
  return { summary: def.description + note, unlocks };
}
