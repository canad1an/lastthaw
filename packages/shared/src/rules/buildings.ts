import { balance } from "../config/balance.js";
import { BUILDINGS, buildingById, type BuildingDef, type SpecialResource, UNITS, TECHS, type UnitDef, type TechDef } from "../config/ages.js";

/** Aggregate effect of every building level in a region. */
export interface RegionEffects {
  capacity: number;
  /** Storage multiplier (1 = base). */
  storage: number;
  /** Additional multiplier applied to food storage only. */
  foodStorage: number;
  yield: { food: number; wood: number; stone: number };
  extract: Partial<Record<SpecialResource, number>>;
  defense: number;
  loyalty: number;
  researchSpeed: number;
  trainSpeed: number;
  protect: number;
  harbor: boolean;
  watchtower: boolean;
  /** Share cut from every hauler leg ending here (waystation levels), before the cap in balance.travel.waystationMaxCut. */
  haul: number;
  airfield: boolean;
  /** Share of attacking aircraft shot down, before the cap in balance.combat.antiAirMax. */
  antiAir: number;
}

export function effectsOf(buildings: Record<string, number>): RegionEffects {
  const e: RegionEffects = {
    capacity: 0,
    storage: 1,
    foodStorage: 0,
    yield: { food: 1, wood: 1, stone: 1 },
    extract: {},
    defense: 0,
    loyalty: 0,
    researchSpeed: 0,
    trainSpeed: 0,
    protect: 0,
    harbor: false,
    watchtower: false,
    haul: 0,
    airfield: false,
    antiAir: 0,
  };
  for (const [id, level] of Object.entries(buildings)) {
    const def = buildingById.get(id);
    if (!def || level <= 0) continue;
    const f = def.effect;
    if (f.capacity) e.capacity += f.capacity * level;
    if (f.storage) e.storage += f.storage * level;
    if (f.foodStorage) e.foodStorage += f.foodStorage * level;
    if (f.yield) for (const k of ["food", "wood", "stone"] as const) e.yield[k] += (f.yield[k] ?? 0) * level;
    if (f.extract) for (const [k, v] of Object.entries(f.extract)) e.extract[k as SpecialResource] = (e.extract[k as SpecialResource] ?? 0) + v * level;
    if (f.defense) e.defense += f.defense * level;
    if (f.loyalty) e.loyalty += f.loyalty * level;
    if (f.researchSpeed) e.researchSpeed += f.researchSpeed * level;
    if (f.trainSpeed) e.trainSpeed += f.trainSpeed * level;
    if (f.protect) e.protect += f.protect * level;
    if (f.harbor) e.harbor = true;
    if (f.watchtower) e.watchtower = true;
    if (f.haul) e.haul += f.haul * level;
    if (f.airfield) e.airfield = true;
    if (f.antiAir) e.antiAir += f.antiAir * level;
  }
  return e;
}

/** Storage caps for the three base resources given a region's building effects. */
export function storageCaps(effects: Pick<RegionEffects, "storage" | "foodStorage">, capital = false): { food: number; wood: number; stone: number } {
  const base = balance.economy.baseStorage;
  const k = capital ? balance.economy.capitalStorageMult : 1;
  return { food: base.food * (effects.storage + effects.foodStorage) * k, wood: base.wood * effects.storage * k, stone: base.stone * effects.storage * k };
}

/** Why a building cannot go in this region, or null if it can. Local-resource and coast rules only. */
export function buildingBlockedBy(def: BuildingDef, region: { resources: readonly string[]; coastal: boolean; name: string }, buildings?: Record<string, number>, isCapital?: boolean): string | null {
  if (def.capitalOnly && isCapital === false) return `${def.name} can only be raised in your capital.`;
  if (def.requiresBuilding && buildings && (buildings[def.requiresBuilding] ?? 0) < 1) {
    return `${def.name} needs ${buildingById.get(def.requiresBuilding)?.name ?? def.requiresBuilding} here first.`;
  }
  if (def.needsResource && !def.needsResource.some((r) => region.resources.includes(r))) {
    const have = region.resources.map((r) => r.replace("_", " ")).join(", ") || "nothing special";
    return `${def.name} needs ${def.needsResource.join(", ")} in the region. ${region.name} has ${have}.`;
  }
  if (def.needsCoast && !region.coastal) return `${def.name} needs a coast. ${region.name} is inland.`;
  return null;
}

/** Defensive works, strongest first. */
export const WALL_ORDER = ["bunker", "arsenal", "castle", "fort", "walls", "palisade"] as const;

/** The strongest defensive building standing in a region, or null. */
export function wallOf(buildings: Record<string, number> | undefined | null): string | null {
  if (!buildings) return null;
  for (const id of WALL_ORDER) if ((buildings[id] ?? 0) >= 1) return id;
  return null;
}

/** Buildings a player of `age` with `techs` may build or upgrade. */
/** The highest level of a building these techs allow: a level needing a tech not known is out of reach, and every level above it. */
export function reachableLevel(def: BuildingDef, techs: ReadonlySet<string>): number {
  let top = def.maxLevel;
  for (const [lv, tech] of Object.entries(def.levelRequires ?? {})) if (!techs.has(tech)) top = Math.min(top, Number(lv) - 1);
  return top;
}

/** What a level is called when it has a name of its own , else null. */
export function levelName(def: BuildingDef, level: number): string | null {
  return def.levelNames?.[level] ?? null;
}

export function availableBuildings(age: number, techs: ReadonlySet<string>): BuildingDef[] {
  return BUILDINGS.filter((b) => b.age <= age && (!b.requires || techs.has(b.requires)));
}

export function availableUnits(age: number, techs: ReadonlySet<string>): UnitDef[] {
  const list = UNITS.filter((u) => !u.hidden && u.age <= age && (!u.requires || techs.has(u.requires)));
  // Once a bigger land hauler is known, the smaller kinds are no longer trained: the research rebuilt them all anyway.
  // Boats are their own ladder: a canoe stays trainable beside a wagon.
  const bestCarry = Math.max(0, ...list.filter((u) => u.hauler && !u.naval).map((u) => u.carry));
  return list.filter((u) => !u.hauler || u.naval || u.carry >= bestCarry);
}

/** Techs a player may research next: right age, prerequisites done, not already done. */
export function availableTechs(age: number, techs: ReadonlySet<string>): TechDef[] {
  return TECHS.filter((t) => t.age <= age && !techs.has(t.id) && (t.requires ?? []).every((r) => techs.has(r)));
}

/** Combined effect of a player's techs on every region they own. */
export interface TechEffects {
  yield: { food: number; wood: number; stone: number };
  capacity: number;
  storage: number;
  growth: number;
  extract: number;
  attack: number;
  defense: number;
  trainSpeed: number;
  researchSpeed: number;
  travel: number;
  loyalty: number;
  /** Hops of live vision beyond your borders (99 = whole map). */
  vision: number;
  /** 0 none, 0.5 halves the plague chance, 1 immune. */
  plagueResist: number;
}

export const NO_TECH_EFFECTS: TechEffects = { yield: { food: 0, wood: 0, stone: 0 }, capacity: 0, storage: 0, growth: 0, extract: 0, attack: 0, defense: 0, trainSpeed: 0, researchSpeed: 0, travel: 0, loyalty: 0, vision: 0, plagueResist: 0 };

export function techEffectsOf(techs: ReadonlySet<string> | readonly string[]): TechEffects {
  const has = techs instanceof Set ? (id: string) => techs.has(id) : (id: string) => (techs as readonly string[]).includes(id);
  const t: TechEffects = { ...NO_TECH_EFFECTS, yield: { food: 0, wood: 0, stone: 0 } };
  for (const def of TECHS) {
    if (!def.effect || !has(def.id)) continue;
    const e = def.effect;
    t.yield.food += e.yield?.food ?? 0;
    t.yield.wood += e.yield?.wood ?? 0;
    t.yield.stone += e.yield?.stone ?? 0;
    t.capacity += e.capacity ?? 0;
    t.storage += e.storage ?? 0;
    t.growth += e.growth ?? 0;
    t.extract += e.extract ?? 0;
    t.attack += e.attack ?? 0;
    t.defense += e.defense ?? 0;
    t.plagueResist = Math.max(t.plagueResist, e.plagueResist ?? 0);
    t.trainSpeed += e.trainSpeed ?? 0;
    t.researchSpeed += e.researchSpeed ?? 0;
    t.travel += e.travel ?? 0;
    t.loyalty += e.loyalty ?? 0;
    t.vision = Math.max(t.vision, e.vision ?? 0);
  }
  return t;
}

/** Region effects from buildings, with the owner's tech effects folded in. */
export function applyTechEffects(e: RegionEffects, t: TechEffects): RegionEffects {
  const extract: Partial<Record<SpecialResource, number>> = {};
  for (const [k, v] of Object.entries(e.extract)) extract[k as SpecialResource] = (v ?? 0) * (1 + t.extract);
  return {
    ...e,
    capacity: e.capacity + t.capacity,
    storage: e.storage + t.storage,
    yield: { food: e.yield.food * (1 + t.yield.food), wood: e.yield.wood * (1 + t.yield.wood), stone: e.yield.stone * (1 + t.yield.stone) },
    extract,
    defense: e.defense + t.defense,
    loyalty: e.loyalty + t.loyalty,
    researchSpeed: e.researchSpeed + t.researchSpeed,
    trainSpeed: e.trainSpeed + t.trainSpeed,
  };
}
