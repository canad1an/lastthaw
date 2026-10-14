/**
 * Content tables: ages, buildings, units and techs. Numbers are starting
 * values meant to be tuned. Costs are for level 1 (buildings) or one unit;
 * see rules/timers.ts for how level and age scale cost and time.
 */

export const AGES = ["Stone", "Bronze", "Iron", "Classical", "Medieval"] as const;
export type AgeIndex = 0 | 1 | 2 | 3 | 4;

/** Everything a job or unit can cost. Metals come from mines on special regions. */
export type CostResource = "food" | "wood" | "stone" | "copper" | "tin" | "iron" | "horses";
export type Cost = Partial<Record<CostResource, number>>;

/** Metals and horses stored per region in `special` alongside the base three. */
export const SPECIAL_RESOURCES = ["copper", "tin", "iron", "horses"] as const;
export type SpecialResource = (typeof SPECIAL_RESOURCES)[number];

export interface BuildingEffect {
  /** Extra population capacity per level. */
  capacity?: number;
  /** Multiplier on storage caps per level (additive: level 2 = 1 + 2 * storage). */
  storage?: number;
  /** Extra multiplier on food storage only, per level. */
  foodStorage?: number;
  /** Yield multipliers per level (additive bonus; 0.1 = +10 % per level). */
  yield?: Partial<Record<"food" | "wood" | "stone", number>>;
  /** Extracts this special resource from a region that has it, units per game hour per level. */
  extract?: Partial<Record<SpecialResource, number>>;
  /** Defensive multiplier bonus per level for battles in this region. */
  defense?: number;
  /** Loyalty bonus per level for occupied regions (fights rebellion). */
  loyalty?: number;
  /** Research/training time multiplier bonus per level (0.05 = 5 % faster). */
  researchSpeed?: number;
  trainSpeed?: number;
  /** Resources protected from raids per level (absolute, per base resource). */
  protect?: number;
  /** Lets armies use sea routes from this region. */
  harbor?: boolean;
  /** Reduces travel time for armies leaving or entering, per level. */
  roads?: number;
}

export interface BuildingDef {
  id: string;
  name: string;
  age: AgeIndex;
  description: string;
  maxLevel: number;
  cost: Cost;
  /** Base build time in seconds at level 1 before the timer curve. */
  baseSeconds: number;
  effect: BuildingEffect;
  /** Required tech id, if any. */
  requires?: string;
  /** The region must have at least one of these special resources. */
  needsResource?: SpecialResource[];
  /** The region must be on a coast. */
  needsCoast?: boolean;
}

export interface UnitDef {
  id: string;
  name: string;
  age: AgeIndex;
  description: string;
  attack: number;
  defense: number;
  /** Travel speed in km per game hour. */
  speed: number;
  /** How much loot one unit can carry on a raid. */
  carry: number;
  cost: Cost;
  baseSeconds: number;
  requires?: string;
  /** Region must have this resource to train here (e.g. horses). */
  needsResource?: SpecialResource;
  /** Not trainable; exists only for combat maths (militia). */
  hidden?: boolean;
  /** Smallest batch that can be trained (settlers travel in groups). */
  minBatch?: number;
  /** Civilians never fight: no raids, conquests or scouting. */
  civilian?: boolean;
}

export interface TechDef {
  id: string;
  name: string;
  age: AgeIndex;
  description: string;
  cost: Cost;
  baseSeconds: number;
  requires?: string[];
  /** Completing this tech moves the player to this age. Announced to everyone. */
  advancesTo?: AgeIndex;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export const BUILDINGS: readonly BuildingDef[] = [
  // Stone
  { id: "huts", name: "Huts", age: 0, description: "Shelter for more families.", maxLevel: 20, cost: { wood: 40, stone: 10 }, baseSeconds: 45, effect: { capacity: 10 } },
  { id: "storehouse", name: "Storehouse", age: 0, description: "Bigger stores, and some stock hidden from raiders.", maxLevel: 20, cost: { wood: 60, stone: 20 }, baseSeconds: 60, effect: { storage: 0.5, protect: 60 } },
  { id: "hunting_grounds", name: "Hunting grounds", age: 0, description: "Better food from the land.", maxLevel: 15, cost: { wood: 30, food: 20 }, baseSeconds: 40, effect: { yield: { food: 0.2 } } },
  { id: "lumber_camp", name: "Lumber camp", age: 0, description: "Faster wood gathering.", maxLevel: 15, cost: { wood: 30, stone: 10 }, baseSeconds: 40, effect: { yield: { wood: 0.25 } } },
  { id: "quarry", name: "Quarry", age: 0, description: "Faster stone gathering.", maxLevel: 15, cost: { wood: 50, food: 30 }, baseSeconds: 50, effect: { yield: { stone: 0.25 } } },
  // Bronze
  { id: "farm", name: "Farm", age: 1, description: "Cultivated fields feed many more people.", maxLevel: 15, cost: { wood: 120, stone: 40 }, baseSeconds: 150, effect: { yield: { food: 0.2 }, capacity: 15 }, requires: "agriculture" },
  { id: "mine", name: "Mine", age: 1, description: "Extracts copper, tin or iron where the region has it.", maxLevel: 10, cost: { wood: 150, stone: 100 }, baseSeconds: 200, effect: { extract: { copper: 1.5, tin: 1.0, iron: 1.2 } }, requires: "mining", needsResource: ["copper", "tin", "iron"] },
  { id: "palisade", name: "Palisade", age: 1, description: "A wooden wall that helps defenders.", maxLevel: 10, cost: { wood: 200, stone: 30 }, baseSeconds: 180, effect: { defense: 0.1 } },
  { id: "stables", name: "Stables", age: 1, description: "Breeds horses where wild herds roam.", maxLevel: 10, cost: { wood: 120, food: 150 }, baseSeconds: 160, effect: { extract: { horses: 0.6 } }, requires: "animal_husbandry", needsResource: ["horses"] },
  { id: "granary", name: "Granary", age: 1, description: "Dry, sealed pits for grain: doubles food storage per level and hides stock from raiders.", maxLevel: 10, cost: { wood: 100, stone: 120 }, baseSeconds: 150, effect: { foodStorage: 1.0, protect: 120 } },
  // Iron
  { id: "forge", name: "Forge", age: 2, description: "Works iron faster; speeds up training.", maxLevel: 10, cost: { wood: 200, stone: 200, iron: 20 }, baseSeconds: 400, effect: { trainSpeed: 0.06, extract: { iron: 0.8 } }, requires: "iron_working" },
  { id: "walls", name: "Stone walls", age: 2, description: "Solid walls around the settlement.", maxLevel: 10, cost: { stone: 400, wood: 100 }, baseSeconds: 500, effect: { defense: 0.18 }, requires: "masonry" },
  { id: "roads", name: "Roads", age: 2, description: "Faster movement and firmer control of distant lands.", maxLevel: 10, cost: { stone: 250, wood: 80 }, baseSeconds: 350, effect: { roads: 0.05, loyalty: 0.08 }, requires: "masonry" },
  { id: "temple", name: "Temple", age: 2, description: "Binds a conquered people to their new rulers.", maxLevel: 10, cost: { stone: 300, wood: 150, food: 100 }, baseSeconds: 450, effect: { loyalty: 0.12 } },
  { id: "barracks", name: "Barracks", age: 2, description: "Trains soldiers faster.", maxLevel: 10, cost: { wood: 300, stone: 150 }, baseSeconds: 400, effect: { trainSpeed: 0.1 } },
  // Classical
  { id: "aqueduct", name: "Aqueduct", age: 3, description: "Clean water lets the city grow.", maxLevel: 10, cost: { stone: 600, wood: 200 }, baseSeconds: 900, effect: { capacity: 40 } },
  { id: "fort", name: "Fort", age: 3, description: "A garrison that defends and holds the province.", maxLevel: 10, cost: { stone: 700, wood: 300, iron: 40 }, baseSeconds: 1000, effect: { defense: 0.15, loyalty: 0.15 } },
  { id: "library", name: "Library", age: 3, description: "Scholars speed up research.", maxLevel: 10, cost: { wood: 500, stone: 400 }, baseSeconds: 900, effect: { researchSpeed: 0.08 }, requires: "writing" },
  { id: "harbor", name: "Harbor", age: 3, description: "Boats carry armies and goods across the sea.", maxLevel: 5, cost: { wood: 800, stone: 300 }, baseSeconds: 1100, effect: { harbor: true }, requires: "shipbuilding", needsCoast: true },
  { id: "market", name: "Market", age: 3, description: "More goods kept safely in town.", maxLevel: 10, cost: { wood: 400, stone: 400 }, baseSeconds: 800, effect: { storage: 0.6, protect: 200 } },
  // Medieval
  { id: "castle", name: "Castle", age: 4, description: "The strongest defence money can build.", maxLevel: 5, cost: { stone: 1500, wood: 500, iron: 120 }, baseSeconds: 2400, effect: { defense: 0.3, loyalty: 0.1 } },
  { id: "windmill", name: "Windmill", age: 4, description: "Grinds grain for a growing population.", maxLevel: 10, cost: { wood: 900, stone: 300 }, baseSeconds: 1800, effect: { yield: { food: 0.25 } } },
  { id: "guild_hall", name: "Guild hall", age: 4, description: "Organised craftsmen work faster.", maxLevel: 10, cost: { wood: 800, stone: 800 }, baseSeconds: 2000, effect: { yield: { wood: 0.2, stone: 0.2 }, trainSpeed: 0.05 } },
  { id: "cathedral", name: "Cathedral", age: 4, description: "A monument that commands loyalty far and wide.", maxLevel: 5, cost: { stone: 2000, wood: 600 }, baseSeconds: 3000, effect: { loyalty: 0.3 } },
  { id: "university", name: "University", age: 4, description: "The fastest research in the land.", maxLevel: 5, cost: { wood: 1200, stone: 1200 }, baseSeconds: 2600, effect: { researchSpeed: 0.15 } },
];

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const UNITS: readonly UnitDef[] = [
  { id: "militia", name: "Militia", age: 0, description: "Villagers with tools, defending their homes.", attack: 1, defense: 2, speed: 0, carry: 0, cost: {}, baseSeconds: 0, hidden: true },
  // Stone
  { id: "warrior", name: "Warrior", age: 0, description: "Club and courage.", attack: 3, defense: 3, speed: 5, carry: 15, cost: { food: 20, wood: 10 }, baseSeconds: 30 },
  { id: "slinger", name: "Slinger", age: 0, description: "Cheap ranged harassment.", attack: 4, defense: 1, speed: 5, carry: 10, cost: { food: 15, stone: 10 }, baseSeconds: 30 },
  { id: "tracker", name: "Tracker", age: 0, description: "Fast and light; ideal for scouting.", attack: 1, defense: 2, speed: 9, carry: 10, cost: { food: 25 }, baseSeconds: 25 },
  { id: "settler", name: "Settler", age: 0, description: "Families with tools and seed grain. A group of five can settle unclaimed land and become its first workers.", attack: 0, defense: 1, speed: 4, carry: 0, cost: { food: 60, wood: 60, stone: 25 }, baseSeconds: 600, minBatch: 5, civilian: true },
  { id: "caravan", name: "Caravan", age: 0, description: "Pack animals and drivers. Each carries 500 of any goods to your regions or an ally's, then walks back. Roads make them faster.", attack: 0, defense: 1, speed: 8, carry: 500, cost: { food: 40, wood: 60 }, baseSeconds: 300, civilian: true },
  // Bronze
  { id: "spearman", name: "Spearman", age: 1, description: "Bronze-tipped spears hold the line.", attack: 5, defense: 7, speed: 5, carry: 20, cost: { food: 30, wood: 15, copper: 2, tin: 1 }, baseSeconds: 60, requires: "bronze_working" },
  { id: "archer", name: "Archer", age: 1, description: "Composite bows strike before the melee.", attack: 7, defense: 3, speed: 5, carry: 15, cost: { food: 30, wood: 30 }, baseSeconds: 60, requires: "bronze_working" },
  { id: "chariot", name: "Chariot", age: 1, description: "Fast and hard-hitting on open ground.", attack: 10, defense: 4, speed: 12, carry: 40, cost: { food: 60, wood: 50, copper: 3, horses: 1 }, baseSeconds: 120, requires: "the_wheel", needsResource: "horses" },
  // Iron
  { id: "swordsman", name: "Swordsman", age: 2, description: "Iron swords cut through bronze.", attack: 10, defense: 9, speed: 5, carry: 25, cost: { food: 50, iron: 4 }, baseSeconds: 120, requires: "iron_working" },
  { id: "cavalry", name: "Cavalry", age: 2, description: "Mounted raiders.", attack: 12, defense: 6, speed: 14, carry: 60, cost: { food: 80, iron: 3, horses: 1 }, baseSeconds: 180, requires: "iron_working", needsResource: "horses" },
  { id: "catapult", name: "Catapult", age: 2, description: "Breaks walls.", attack: 18, defense: 2, speed: 3, carry: 0, cost: { wood: 200, iron: 6 }, baseSeconds: 300, requires: "siegecraft" },
  // Classical
  { id: "legionary", name: "Legionary", age: 3, description: "Disciplined heavy infantry.", attack: 15, defense: 15, speed: 6, carry: 30, cost: { food: 90, iron: 8 }, baseSeconds: 240, requires: "drill" },
  { id: "cataphract", name: "Cataphract", age: 3, description: "Armoured horse and rider.", attack: 20, defense: 12, speed: 12, carry: 50, cost: { food: 150, iron: 10, horses: 1 }, baseSeconds: 360, requires: "drill", needsResource: "horses" },
  { id: "ballista", name: "Ballista", age: 3, description: "Precise siege engine.", attack: 28, defense: 4, speed: 3, carry: 0, cost: { wood: 350, iron: 15 }, baseSeconds: 480, requires: "engineering" },
  // Medieval
  { id: "knight", name: "Knight", age: 4, description: "The finest heavy cavalry.", attack: 32, defense: 22, speed: 12, carry: 70, cost: { food: 250, iron: 20, horses: 1 }, baseSeconds: 600, requires: "chivalry", needsResource: "horses" },
  { id: "longbowman", name: "Longbowman", age: 4, description: "Deadly at range.", attack: 24, defense: 10, speed: 6, carry: 30, cost: { food: 120, wood: 80 }, baseSeconds: 420, requires: "chivalry" },
  { id: "trebuchet", name: "Trebuchet", age: 4, description: "Nothing stands against it for long.", attack: 45, defense: 5, speed: 2, carry: 0, cost: { wood: 700, iron: 30 }, baseSeconds: 900, requires: "siege_engines" },
];

// ---------------------------------------------------------------------------
// Techs. Each age ends with an advancement project announced to the match.
// ---------------------------------------------------------------------------

export const TECHS: readonly TechDef[] = [
  // Stone
  { id: "fire_making", name: "Fire making", age: 0, description: "Cooked food and warm nights.", cost: { food: 60, wood: 40 }, baseSeconds: 90 },
  { id: "flint_tools", name: "Flint tools", age: 0, description: "Sharper tools for every task.", cost: { stone: 30, wood: 40 }, baseSeconds: 120 },
  { id: "agriculture", name: "Agriculture", age: 0, description: "Planting instead of only gathering.", cost: { food: 150, wood: 80 }, baseSeconds: 240, requires: ["fire_making"] },
  { id: "animal_husbandry", name: "Animal husbandry", age: 0, description: "Tame the herds.", cost: { food: 150, wood: 60 }, baseSeconds: 240, requires: ["fire_making"] },
  { id: "bronze_working", name: "Bronze working", age: 0, description: "Copper and tin make bronze. Enters the Bronze Age.", cost: { food: 300, wood: 250, stone: 200 }, baseSeconds: 7200, requires: ["flint_tools", "agriculture"], advancesTo: 1 },
  // Bronze
  { id: "mining", name: "Mining", age: 1, description: "Dig for metals.", cost: { wood: 300, stone: 300 }, baseSeconds: 600 },
  { id: "the_wheel", name: "The wheel", age: 1, description: "Carts and chariots.", cost: { wood: 400, food: 200 }, baseSeconds: 700, requires: ["animal_husbandry"] },
  { id: "writing", name: "Writing", age: 1, description: "Records and learning.", cost: { food: 300, wood: 300 }, baseSeconds: 800 },
  { id: "iron_working", name: "Iron working", age: 1, description: "Smelt iron. Enters the Iron Age.", cost: { wood: 5000, stone: 3000, copper: 40 }, baseSeconds: 14400, requires: ["mining"], advancesTo: 2 },
  // Iron
  { id: "siegecraft", name: "Siegecraft", age: 2, description: "Engines to break walls.", cost: { wood: 900, iron: 40 }, baseSeconds: 1800 },
  { id: "masonry", name: "Masonry", age: 2, description: "Cut and fitted stone. Unlocks Stone walls and Roads, and leads to Drill.", cost: { stone: 1000, wood: 400 }, baseSeconds: 1800 },
  { id: "drill", name: "Drill", age: 2, description: "Professional soldiers. Enters the Classical Age.", cost: { food: 40000, wood: 25000, iron: 300 }, baseSeconds: 21600, requires: ["masonry", "writing"], advancesTo: 3 },
  // Classical
  { id: "shipbuilding", name: "Shipbuilding", age: 3, description: "Boats that cross open sea.", cost: { wood: 2000, stone: 500 }, baseSeconds: 4800 },
  { id: "engineering", name: "Engineering", age: 3, description: "Aqueducts and ballistae.", cost: { stone: 1800, wood: 800, iron: 60 }, baseSeconds: 4800 },
  { id: "chivalry", name: "Chivalry", age: 3, description: "Knights and castles. Enters the Medieval Age.", cost: { food: 150000, wood: 80000, iron: 1000 }, baseSeconds: 28800, requires: ["engineering"], advancesTo: 4 },
  // Medieval
  { id: "siege_engines", name: "Siege engines", age: 4, description: "Trebuchets.", cost: { wood: 3000, iron: 200 }, baseSeconds: 9000 },
  { id: "scholasticism", name: "Scholasticism", age: 4, description: "Universities.", cost: { wood: 2500, stone: 2500 }, baseSeconds: 9000 },
];

export const buildingById = new Map(BUILDINGS.map((b) => [b.id, b]));
export const unitById = new Map(UNITS.map((u) => [u.id, u]));
export const techById = new Map(TECHS.map((t) => [t.id, t]));
