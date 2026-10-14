import { BUILDINGS, buildingById, type BuildingDef, type SpecialResource, UNITS, TECHS, type UnitDef, type TechDef } from "../config/ages.js";

/** Aggregate effect of every building level in a region. */
export interface RegionEffects {
  capacity: number;
  /** Storage multiplier (1 = base). */
  storage: number;
  yield: { food: number; wood: number; stone: number };
  extract: Partial<Record<SpecialResource, number>>;
  defense: number;
  loyalty: number;
  researchSpeed: number;
  trainSpeed: number;
  protect: number;
  harbor: boolean;
  roads: number;
}

export function effectsOf(buildings: Record<string, number>): RegionEffects {
  const e: RegionEffects = {
    capacity: 0,
    storage: 1,
    yield: { food: 1, wood: 1, stone: 1 },
    extract: {},
    defense: 0,
    loyalty: 0,
    researchSpeed: 0,
    trainSpeed: 0,
    protect: 0,
    harbor: false,
    roads: 0,
  };
  for (const [id, level] of Object.entries(buildings)) {
    const def = buildingById.get(id);
    if (!def || level <= 0) continue;
    const f = def.effect;
    if (f.capacity) e.capacity += f.capacity * level;
    if (f.storage) e.storage += f.storage * level;
    if (f.yield) for (const k of ["food", "wood", "stone"] as const) e.yield[k] += (f.yield[k] ?? 0) * level;
    if (f.extract) for (const [k, v] of Object.entries(f.extract)) e.extract[k as SpecialResource] = (e.extract[k as SpecialResource] ?? 0) + v * level;
    if (f.defense) e.defense += f.defense * level;
    if (f.loyalty) e.loyalty += f.loyalty * level;
    if (f.researchSpeed) e.researchSpeed += f.researchSpeed * level;
    if (f.trainSpeed) e.trainSpeed += f.trainSpeed * level;
    if (f.protect) e.protect += f.protect * level;
    if (f.harbor) e.harbor = true;
    if (f.roads) e.roads += f.roads * level;
  }
  return e;
}

/** Buildings a player of `age` with `techs` may build or upgrade. */
export function availableBuildings(age: number, techs: ReadonlySet<string>): BuildingDef[] {
  return BUILDINGS.filter((b) => b.age <= age && (!b.requires || techs.has(b.requires)));
}

export function availableUnits(age: number, techs: ReadonlySet<string>): UnitDef[] {
  return UNITS.filter((u) => !u.hidden && u.age <= age && (!u.requires || techs.has(u.requires)));
}

/** Techs a player may research next: right age, prerequisites done, not already done. */
export function availableTechs(age: number, techs: ReadonlySet<string>): TechDef[] {
  return TECHS.filter((t) => t.age <= age && !techs.has(t.id) && (t.requires ?? []).every((r) => techs.has(r)));
}
