/**
 * Content tables: ages, buildings, units and techs. Numbers are starting
 * values meant to be tuned. Costs are for level 1 (buildings) or one unit;
 * see rules/timers.ts for how level and age scale cost and time.
 */

export const AGES = ["Stone", "Bronze", "Iron", "Classical", "Medieval", "Industrial", "Modern"] as const;
export type AgeIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

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

}

export type BuildingCategory = "growth" | "production" | "storage" | "defense" | "training" | "transport" | "loyalty" | "wonder";

/** Build-tab groups, in display order. */
export const BUILDING_CATEGORIES: ReadonlyArray<{ id: BuildingCategory; name: string; hint: string; icon: string }> = [
  { id: "growth", name: "Growth & food", hint: "More people and the food to keep them.", icon: "🌾" },
  { id: "production", name: "Production", hint: "Faster wood, stone, ore and horses.", icon: "⚒" },
  { id: "storage", name: "Storage", hint: "Bigger stores, and stock hidden from raiders.", icon: "🏺" },
  { id: "defense", name: "Defence", hint: "Walls and garrisons that help defenders.", icon: "🛡" },
  { id: "training", name: "Training & research", hint: "Faster soldiers and faster science.", icon: "📜" },
  { id: "transport", name: "Transport", hint: "Roads, rails and harbours that speed up every trip.", icon: "🛣" },
  { id: "loyalty", name: "Loyalty", hint: "Keep conquered people from rebelling.", icon: "⚜" },
  { id: "wonder", name: "Wonder", hint: "Finish it first and the match is yours. Everyone is told the moment you begin.", icon: "🔥" },
];

export interface BuildingDef {
  category: BuildingCategory;
  /** Cost is per adjacent region: one build connects the region to all of its neighbours. */
  perNeighbor?: boolean;
  /** Needs this building in the region first (Railway needs Roads). */
  requiresBuilding?: string;
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
  /** Only the capital may build it. */
  capitalOnly?: boolean;
  /** A wonder: priced and timed absolutely (no day multiplier, no build-time cap); finishing it wins the match. */
  wonder?: boolean;
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
  /** Carries goods on trade routes, overflow and transports (caravan, wagon, train). */
  hauler?: boolean;
  /** A ship: sails one sea lane at a time between coasts, fights other ships on the lane, built only where there is a Harbor. */
  naval?: boolean;
  /** Region must have this building to train here (ships need a Harbor). */
  needsBuilding?: string;
  /** Civilians never fight: no raids, conquests or scouting. */
  civilian?: boolean;
}

/** What a tech does for every region the player owns, on top of unlocking things. Fractions add up across techs. */
export interface TechEffect {
  yield?: Partial<Record<"food" | "wood" | "stone", number>>;
  capacity?: number;
  /** Extra storage as a fraction of the cap (0.25 = +25%). */
  storage?: number;
  /** Population growth multiplier bonus (0.2 = +20%). */
  growth?: number;
  /** Ore and horse extraction bonus (0.5 = +50%). */
  extract?: number;
  attack?: number;
  defense?: number;
  trainSpeed?: number;
  researchSpeed?: number;
  /** Army and caravan travel speed bonus. */
  travel?: number;
  loyalty?: number;
  /** Vision in hops beyond your borders (99 = the whole map). */
  vision?: number;
}

export interface TechDef {
  id: string;
  name: string;
  age: AgeIndex;
  description: string;
  cost: Cost;
  baseSeconds: number;
  requires?: string[];
  effect?: TechEffect;
  /** Completing this tech moves the player to this age. Announced to everyone. */
  advancesTo?: AgeIndex;
  /** Cannot be started before this match day (0-based): the hard pacing floor for age advances. */
  earliestDay?: number;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export const BUILDINGS: readonly BuildingDef[] = [
  // Stone
  { id: "huts", category: "growth", name: "Huts", age: 0, description: "Shelter for more families.", maxLevel: 20, cost: { wood: 40, stone: 10 }, baseSeconds: 45, effect: { capacity: 10 } },
  { id: "storehouse", category: "storage", name: "Storehouse", age: 0, description: "Bigger stores, and some stock hidden from raiders.", maxLevel: 20, cost: { wood: 60, stone: 20 }, baseSeconds: 60, effect: { storage: 0.5, protect: 60 } },
  { id: "hunting_grounds", category: "growth", name: "Hunting grounds", age: 0, description: "Better food from the land. Farms take over once you have them.", maxLevel: 10, cost: { wood: 30, food: 20 }, baseSeconds: 40, effect: { yield: { food: 0.15 } } },
  { id: "lumber_camp", category: "production", name: "Lumber camp", age: 0, description: "Faster wood gathering.", maxLevel: 15, cost: { wood: 30, stone: 10 }, baseSeconds: 40, effect: { yield: { wood: 0.25 } } },
  { id: "quarry", category: "production", name: "Quarry", age: 0, description: "Faster stone gathering.", maxLevel: 15, cost: { wood: 50, food: 30 }, baseSeconds: 50, effect: { yield: { stone: 0.25 } } },
  // Bronze
  { id: "farm", category: "growth", name: "Farm", age: 1, description: "Cultivated fields feed many more people.", maxLevel: 15, cost: { wood: 120, stone: 40 }, baseSeconds: 150, effect: { yield: { food: 0.2 }, capacity: 15 }, requires: "agriculture" },
  { id: "mine", category: "production", name: "Mine", age: 1, description: "Extracts copper, tin or iron where the region has it.", maxLevel: 10, cost: { wood: 150, stone: 100 }, baseSeconds: 200, effect: { extract: { copper: 1.5, tin: 1.0, iron: 1.2 } }, requires: "mining", needsResource: ["copper", "tin", "iron"] },
  { id: "palisade", category: "defense", name: "Palisade", age: 1, description: "A wooden wall that helps defenders.", maxLevel: 10, cost: { wood: 200, stone: 30 }, baseSeconds: 180, effect: { defense: 0.1 } },
  { id: "stables", category: "production", name: "Stables", age: 1, description: "Breeds horses where wild herds roam.", maxLevel: 10, cost: { wood: 120, food: 150 }, baseSeconds: 160, effect: { extract: { horses: 0.6 } }, requires: "animal_husbandry", needsResource: ["horses"] },
  { id: "granary", category: "storage", name: "Granary", age: 1, description: "Dry, sealed pits for grain: half again as much food storage per level, and stock hidden from raiders.", maxLevel: 10, cost: { wood: 100, stone: 120 }, baseSeconds: 150, effect: { foodStorage: 0.5, protect: 120 } },
  // Iron
  { id: "forge", category: "training", name: "Forge", age: 2, description: "Works iron faster; speeds up training.", maxLevel: 10, cost: { wood: 200, stone: 200, iron: 20 }, baseSeconds: 400, effect: { trainSpeed: 0.06, extract: { iron: 0.8 } }, requires: "iron_working" },
  { id: "walls", category: "defense", name: "Stone walls", age: 2, description: "Solid walls around the settlement.", maxLevel: 10, cost: { stone: 400, wood: 100 }, baseSeconds: 500, effect: { defense: 0.18 }, requires: "masonry" },
  { id: "roads", category: "transport", name: "Roads", age: 1, description: "Paved roads to every neighbouring region. Built once; legs between two road regions are much faster, and the region is easier to hold.", maxLevel: 1, cost: { stone: 80, wood: 40 }, perNeighbor: true, baseSeconds: 600, effect: { loyalty: 0.1 }, requires: "road_building" },
  { id: "railway", category: "transport", name: "Railway", age: 4, description: "Rails to every neighbouring region that also has them. Built once on top of Roads; legs between two railway regions are far faster.", maxLevel: 1, cost: { stone: 400, iron: 20 }, perNeighbor: true, baseSeconds: 1800, effect: { loyalty: 0.05 }, requires: "railways", requiresBuilding: "roads" },
  { id: "temple", category: "loyalty", name: "Temple", age: 2, description: "Binds a conquered people to their new rulers. Built once: raises loyalty and keeps turning workers into occupiers until the region has enough, however much it grows.", maxLevel: 1, cost: { stone: 1500, wood: 800, food: 500 }, baseSeconds: 2400, effect: { loyalty: 0.2 } },
  { id: "barracks", category: "training", name: "Barracks", age: 2, description: "Trains soldiers faster.", maxLevel: 10, cost: { wood: 300, stone: 150 }, baseSeconds: 400, effect: { trainSpeed: 0.1 } },
  // Classical
  { id: "aqueduct", category: "growth", name: "Aqueduct", age: 3, description: "Clean water lets the city grow.", maxLevel: 10, cost: { stone: 600, wood: 200 }, baseSeconds: 900, effect: { capacity: 40 } },
  { id: "fort", category: "defense", name: "Fort", age: 3, description: "A garrison that defends and holds the province.", maxLevel: 10, cost: { stone: 700, wood: 300, iron: 40 }, baseSeconds: 1000, effect: { defense: 0.15, loyalty: 0.15 } },
  { id: "library", category: "training", name: "Library", age: 3, description: "Scholars speed up research.", maxLevel: 10, cost: { wood: 500, stone: 400 }, baseSeconds: 900, effect: { researchSpeed: 0.08 }, requires: "writing" },
  { id: "harbor", category: "transport", name: "Harbor", age: 3, description: "Quays and boats. Built once on a coast: sea legs to another harbour of yours are far faster, and faster still than open water at one end.", maxLevel: 1, cost: { wood: 2500, stone: 1500 }, baseSeconds: 1800, effect: { harbor: true }, requires: "shipbuilding", needsCoast: true },
  { id: "market", category: "storage", name: "Market", age: 3, description: "More goods kept safely in town.", maxLevel: 10, cost: { wood: 400, stone: 400 }, baseSeconds: 800, effect: { storage: 0.6, protect: 200 } },
  // Medieval
  { id: "castle", category: "defense", name: "Castle", age: 4, description: "The strongest defence money can build.", maxLevel: 5, cost: { stone: 1500, wood: 500, iron: 120 }, baseSeconds: 2400, effect: { defense: 0.3, loyalty: 0.1 } },
  { id: "windmill", category: "growth", name: "Windmill", age: 4, description: "Grinds grain for a growing population.", maxLevel: 10, cost: { wood: 900, stone: 300 }, baseSeconds: 1800, effect: { yield: { food: 0.15 } } },
  { id: "guild_hall", category: "production", name: "Guild hall", age: 4, description: "Organised craftsmen work faster.", maxLevel: 10, cost: { wood: 800, stone: 800 }, baseSeconds: 2000, effect: { yield: { wood: 0.2, stone: 0.2 }, trainSpeed: 0.05 } },
  { id: "cathedral", category: "loyalty", name: "Cathedral", age: 4, description: "A monument that commands loyalty far and wide.", maxLevel: 5, cost: { stone: 2000, wood: 600 }, baseSeconds: 3000, effect: { loyalty: 0.3 } },
  // Industrial
  { id: "factory", category: "production", name: "Factory", age: 5, description: "Machines and shifts: trains troops faster and turns out more wood and stone.", maxLevel: 10, cost: { wood: 3000, stone: 2500, iron: 100 }, baseSeconds: 3000, effect: { trainSpeed: 0.1, yield: { wood: 0.1, stone: 0.1 } }, requires: "steam_power" },
  { id: "arsenal", category: "defense", name: "Arsenal", age: 5, description: "Stores of powder and shot: a hard place to take.", maxLevel: 5, cost: { stone: 5000, iron: 300 }, baseSeconds: 3600, effect: { defense: 0.25, protect: 2000 } },
  // Modern
  { id: "power_plant", category: "production", name: "Power plant", age: 6, description: "Electricity for every workshop and field.", maxLevel: 10, cost: { stone: 8000, iron: 400 }, baseSeconds: 4000, effect: { yield: { food: 0.15, wood: 0.15, stone: 0.15 }, capacity: 20 }, requires: "electricity" },
  { id: "bunker", category: "defense", name: "Bunker", age: 6, description: "Concrete and steel: the strongest defence there is.", maxLevel: 5, cost: { stone: 6000, iron: 500 }, baseSeconds: 3600, effect: { defense: 0.5 } },
  { id: "great_hearth", category: "wonder", name: "Great Hearth", age: 4, description: "A hall of fire and stone where a whole people can wait out the ice. Only the capital can raise it; it takes three days and the wealth of an empire, and every rival hears when the first stone is laid. Finish it and you win.", maxLevel: 1, cost: { wood: 80000, stone: 80000, food: 40000, iron: 6000 }, baseSeconds: 3 * 86400, effect: {}, requires: "engineering", capitalOnly: true, wonder: true },
  { id: "university", category: "training", name: "University", age: 4, description: "The fastest research in the land.", maxLevel: 5, cost: { wood: 1200, stone: 1200 }, baseSeconds: 2600, effect: { researchSpeed: 0.15 } },
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
  { id: "caravan", name: "Caravan", age: 0, description: "Pack animals and drivers. Carries goods to your regions or an ally's, then walks back. Roads make it faster; Wagons and Trains carry more.", attack: 0, defense: 1, speed: 8, carry: 500, cost: { food: 40, wood: 60 }, baseSeconds: 300, civilian: true, hauler: true },
  // Bronze
  { id: "wagon", name: "Wagon", age: 1, description: "A proper cart and team: carries more than twice a caravan and moves faster.", attack: 0, defense: 1, speed: 12, carry: 1200, cost: { food: 60, wood: 150 }, baseSeconds: 420, requires: "wagon_building", civilian: true, hauler: true },
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
  { id: "galley", name: "Galley", age: 3, description: "Oared warship. Escorts crossings and sinks what it meets on its lane.", attack: 20, defense: 15, speed: 12, carry: 400, cost: { wood: 400, food: 100 }, baseSeconds: 420, requires: "shipbuilding", naval: true, needsBuilding: "harbor" },
  // Medieval
  { id: "train", name: "Train", age: 4, description: "Iron rails and steam: carries eight caravans' worth and moves four times as fast. Needs Railways.", attack: 0, defense: 1, speed: 30, carry: 4000, cost: { wood: 400, iron: 30 }, baseSeconds: 900, requires: "railways", civilian: true, hauler: true },
  { id: "knight", name: "Knight", age: 4, description: "The finest heavy cavalry.", attack: 32, defense: 22, speed: 12, carry: 70, cost: { food: 250, iron: 20, horses: 1 }, baseSeconds: 600, requires: "chivalry", needsResource: "horses" },
  { id: "longbowman", name: "Longbowman", age: 4, description: "Deadly at range.", attack: 24, defense: 10, speed: 6, carry: 30, cost: { food: 120, wood: 80 }, baseSeconds: 420, requires: "chivalry" },
  { id: "trebuchet", name: "Trebuchet", age: 4, description: "Nothing stands against it for long.", attack: 45, defense: 5, speed: 2, carry: 0, cost: { wood: 700, iron: 30 }, baseSeconds: 900, requires: "siege_engines" },
  { id: "cog", name: "Cog", age: 4, description: "Broad-beamed merchantman: hauls like three wagons across a sea lane, and can carry settlers to a new shore.", attack: 5, defense: 10, speed: 14, carry: 3000, cost: { wood: 900, iron: 20 }, baseSeconds: 600, requires: "shipbuilding", naval: true, hauler: true, needsBuilding: "harbor" },
  // Industrial
  { id: "rifleman", name: "Rifleman", age: 5, description: "Drilled infantry with rifled muskets.", attack: 40, defense: 35, speed: 6, carry: 40, cost: { food: 150, iron: 25 }, baseSeconds: 300, requires: "rifling" },
  { id: "cannon", name: "Cannon", age: 5, description: "Field guns that break walls and lines alike.", attack: 70, defense: 8, speed: 4, carry: 0, cost: { wood: 800, iron: 60 }, baseSeconds: 600, requires: "steam_power" },
  { id: "ironclad", name: "Ironclad", age: 5, description: "Steam and armour plate: masters any lane it patrols.", attack: 120, defense: 100, speed: 16, carry: 600, cost: { iron: 300, wood: 1500 }, baseSeconds: 1200, requires: "steam_power", naval: true, needsBuilding: "harbor" },
  // Modern
  { id: "infantry", name: "Infantry", age: 6, description: "Modern soldiers with automatic weapons.", attack: 70, defense: 60, speed: 7, carry: 50, cost: { food: 250, iron: 40 }, baseSeconds: 420, requires: "combined_arms" },
  { id: "tank", name: "Tank", age: 6, description: "Armour and a gun on tracks: fast and nearly unstoppable.", attack: 140, defense: 70, speed: 20, carry: 80, cost: { iron: 150, wood: 500 }, baseSeconds: 900, requires: "combined_arms" },
  { id: "artillery", name: "Artillery", age: 6, description: "Long guns that flatten anything in range.", attack: 200, defense: 10, speed: 5, carry: 0, cost: { iron: 120, wood: 600 }, baseSeconds: 900, requires: "ballistics" },
  { id: "destroyer", name: "Destroyer", age: 6, description: "Fast, gunned and radar-guided.", attack: 250, defense: 200, speed: 24, carry: 800, cost: { iron: 800, wood: 2000 }, baseSeconds: 1500, requires: "electronics", naval: true, needsBuilding: "harbor" },
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
  { id: "weaving", name: "Weaving", age: 0, description: "Cloth and shelter for more families.", cost: { food: 120, wood: 80 }, baseSeconds: 300, effect: { capacity: 10 } },
  { id: "fishing_nets", name: "Fishing nets", age: 0, description: "Nets and traps: more food from rivers and shores.", cost: { wood: 150, food: 60 }, baseSeconds: 300, requires: ["fire_making"], effect: { yield: { food: 0.15 } } },
  { id: "stone_axes", name: "Stone axes", age: 0, description: "Better tools for felling and quarrying.", cost: { wood: 120, stone: 80 }, baseSeconds: 360, requires: ["flint_tools"], effect: { yield: { wood: 0.15, stone: 0.1 } } },
  { id: "bronze_working", name: "Bronze working", age: 0, description: "Copper and tin make bronze. Enters the Bronze Age.", cost: { food: 300, wood: 250, stone: 200 }, baseSeconds: 7200, requires: ["flint_tools", "agriculture"], advancesTo: 1 },
  // Bronze
  { id: "mining", name: "Mining", age: 1, description: "Dig for metals.", cost: { wood: 300, stone: 300 }, baseSeconds: 600 },
  { id: "the_wheel", name: "The wheel", age: 1, description: "Carts and chariots.", cost: { wood: 400, food: 200 }, baseSeconds: 700, requires: ["animal_husbandry"] },
  { id: "road_building", name: "Road building", age: 1, description: "Surveyed, drained and paved ways. Lets a region build Roads to all of its neighbours.", cost: { wood: 600, stone: 400 }, baseSeconds: 900, requires: ["the_wheel"] },
  { id: "wagon_building", name: "Wagon building", age: 1, description: "Axles, beds and teams. When it completes, every caravan you have becomes a Wagon: more than twice the load, half again the speed.", cost: { wood: 3000, stone: 1500, food: 1000 }, baseSeconds: 7200, requires: ["the_wheel"] },
  { id: "writing", name: "Writing", age: 1, description: "Records and learning.", cost: { food: 300, wood: 300 }, baseSeconds: 800 },
  { id: "irrigation", name: "Irrigation", age: 1, description: "Ditches and channels: fields yield more.", cost: { wood: 1200, stone: 600 }, baseSeconds: 1800, requires: ["agriculture"], effect: { yield: { food: 0.15 } } },
  { id: "pottery", name: "Pottery", age: 1, description: "Sealed jars keep more in store.", cost: { stone: 900, wood: 600 }, baseSeconds: 1500, effect: { storage: 0.25 } },
  { id: "bronze_weapons", name: "Bronze weapons", age: 1, description: "Cast blades and spearheads for every soldier.", cost: { wood: 800, stone: 400, copper: 10 }, baseSeconds: 1800, effect: { attack: 0.1, defense: 0.05 } },
  { id: "herbal_medicine", name: "Herbal medicine", age: 1, description: "Fewer die young: people grow faster.", cost: { food: 1500, wood: 500 }, baseSeconds: 1500, effect: { growth: 0.2 } },
  { id: "iron_working", name: "Iron working", age: 1, description: "Smelt iron. Enters the Iron Age.", cost: { wood: 5000, stone: 3000, copper: 40 }, baseSeconds: 14400, requires: ["mining"], advancesTo: 2, earliestDay: 4 },
  // Iron
  { id: "siegecraft", name: "Siegecraft", age: 2, description: "Engines to break walls.", cost: { wood: 900, iron: 40 }, baseSeconds: 1800 },
  { id: "masonry", name: "Masonry", age: 2, description: "Cut and fitted stone. Unlocks Stone walls and leads to Drill.", cost: { stone: 1000, wood: 400 }, baseSeconds: 1800 },
  { id: "crop_rotation", name: "Crop rotation", age: 2, description: "Rested fields feed more.", cost: { food: 6000, wood: 3000 }, baseSeconds: 3600, requires: ["irrigation"], effect: { yield: { food: 0.15 } } },
  { id: "iron_tools", name: "Iron tools", age: 2, description: "Iron axes and picks for the camps and quarries.", cost: { wood: 4000, stone: 3000, iron: 30 }, baseSeconds: 3600, effect: { yield: { wood: 0.2, stone: 0.2 } } },
  { id: "iron_weapons", name: "Iron weapons", age: 2, description: "Harder edges for every soldier.", cost: { wood: 3000, iron: 60 }, baseSeconds: 4200, requires: ["bronze_weapons"], effect: { attack: 0.15, defense: 0.1 } },
  { id: "mathematics", name: "Mathematics", age: 2, description: "Numbers and records: research goes faster.", cost: { food: 4000, stone: 2500 }, baseSeconds: 3600, requires: ["writing"], effect: { researchSpeed: 0.15 } },
  { id: "drill", name: "Drill", age: 2, description: "Professional soldiers. Enters the Classical Age.", cost: { food: 40000, wood: 25000, iron: 500 }, baseSeconds: 21600, requires: ["masonry", "writing"], advancesTo: 3, earliestDay: 9 },
  // Classical
  { id: "shipbuilding", name: "Shipbuilding", age: 3, description: "Boats that cross open sea.", cost: { wood: 2000, stone: 500 }, baseSeconds: 4800 },
  { id: "engineering", name: "Engineering", age: 3, description: "Aqueducts and ballistae.", cost: { stone: 1800, wood: 800, iron: 60 }, baseSeconds: 4800 },
  { id: "philosophy", name: "Philosophy", age: 3, description: "Schools of thought: research goes faster still.", cost: { food: 15000, wood: 8000 }, baseSeconds: 7200, requires: ["mathematics"], effect: { researchSpeed: 0.2 } },
  { id: "steel", name: "Steel", age: 3, description: "Forged steel for blades and mail.", cost: { wood: 10000, iron: 150 }, baseSeconds: 9000, requires: ["iron_weapons"], effect: { attack: 0.2, defense: 0.15 } },
  { id: "logistics", name: "Logistics", age: 3, description: "Supply trains and relays: armies and caravans move faster.", cost: { food: 12000, wood: 10000 }, baseSeconds: 7200, requires: ["road_building"], effect: { travel: 0.2 } },
  { id: "civil_service", name: "Civil service", age: 3, description: "Governors and clerks keep distant lands loyal.", cost: { food: 10000, stone: 8000 }, baseSeconds: 7200, requires: ["writing"], effect: { loyalty: 0.1 } },
  { id: "heavy_plough", name: "Heavy plough", age: 3, description: "Turns heavy soils that hoes never could.", cost: { wood: 15000, iron: 80 }, baseSeconds: 9000, requires: ["crop_rotation"], effect: { yield: { food: 0.2 } } },
  { id: "chivalry", name: "Chivalry", age: 3, description: "Knights and castles. Enters the Medieval Age.", cost: { food: 150000, wood: 80000, iron: 1500 }, baseSeconds: 28800, requires: ["engineering"], advancesTo: 4, earliestDay: 14 },
  // Medieval
  { id: "three_field_system", name: "Three-field system", age: 4, description: "A third of the land rests while two thirds feed.", cost: { food: 40000, wood: 25000 }, baseSeconds: 14400, requires: ["heavy_plough"], effect: { yield: { food: 0.2 } } },
  { id: "blast_furnace", name: "Blast furnace", age: 4, description: "Far more metal from every mine.", cost: { stone: 30000, iron: 300 }, baseSeconds: 14400, effect: { extract: 0.5 } },
  { id: "plate_armour", name: "Plate armour", age: 4, description: "Full harness for the heavy troops.", cost: { iron: 400, wood: 20000 }, baseSeconds: 18000, requires: ["steel"], effect: { defense: 0.25 } },
  { id: "guilds", name: "Guilds", age: 4, description: "Organised crafts: more wood and stone from every camp.", cost: { food: 30000, stone: 20000 }, baseSeconds: 14400, effect: { yield: { wood: 0.25, stone: 0.25 } } },
  { id: "railways", name: "Railways", age: 4, description: "Iron rails and steam engines. When it completes, every wagon you have becomes a Train, and Railway can be built on top of Roads.", cost: { stone: 60000, wood: 40000, iron: 2000 }, baseSeconds: 28800, requires: ["engineering", "wagon_building"] },
  { id: "siege_engines", name: "Siege engines", age: 4, description: "Trebuchets.", cost: { wood: 3000, iron: 200 }, baseSeconds: 9000 },
  { id: "scholasticism", name: "Scholasticism", age: 4, description: "Universities: research goes much faster.", cost: { wood: 2500, stone: 2500 }, baseSeconds: 9000, effect: { researchSpeed: 0.3 } },
  { id: "industrialisation", name: "Industrialisation", age: 4, description: "Coal, iron and machines. Enters the Industrial Age.", cost: { food: 300000, wood: 200000, iron: 3000 }, baseSeconds: 28800, requires: ["engineering", "railways"], advancesTo: 5, earliestDay: 19 },
  // Industrial
  { id: "steam_power", name: "Steam power", age: 5, description: "Engines that never tire: more wood and stone, and unlocks the Factory and Cannon.", cost: { stone: 50000, wood: 40000, iron: 800 }, baseSeconds: 14400, effect: { yield: { wood: 0.3, stone: 0.3 } } },
  { id: "telegraph", name: "Telegraph", age: 5, description: "Wires carry word in an instant: research goes much faster.", cost: { stone: 30000, wood: 30000, iron: 400 }, baseSeconds: 10800, effect: { researchSpeed: 0.3 } },
  { id: "rifling", name: "Rifling", age: 5, description: "Grooved barrels: unlocks the Rifleman.", cost: { iron: 1500, wood: 30000 }, baseSeconds: 14400, effect: { attack: 0.25, defense: 0.1 } },
  { id: "vaccination", name: "Vaccination", age: 5, description: "Far fewer die of disease.", cost: { food: 80000, stone: 20000 }, baseSeconds: 10800, effect: { growth: 0.4 } },
  { id: "electronics", name: "Electronics", age: 5, description: "Circuits and radio. Enters the Modern Age.", cost: { food: 600000, wood: 400000, iron: 6000 }, baseSeconds: 28800, requires: ["telegraph", "steam_power"], advancesTo: 6, earliestDay: 24 },
  // Modern
  { id: "electricity", name: "Electricity", age: 6, description: "Power for everything: unlocks the Power plant.", cost: { iron: 3000, stone: 80000 }, baseSeconds: 14400, effect: { yield: { food: 0.25, wood: 0.25, stone: 0.25 } } },
  { id: "radar", name: "Radar", age: 6, description: "See every region within two hops of your borders, live.", cost: { iron: 2500, wood: 60000 }, baseSeconds: 14400, effect: { vision: 2 } },
  { id: "satellites", name: "Satellites", age: 6, description: "Eyes in orbit: the whole map, live.", cost: { iron: 8000, stone: 150000 }, baseSeconds: 21600, requires: ["radar"], effect: { vision: 99 } },
  { id: "combined_arms", name: "Combined arms", age: 6, description: "Infantry, armour and guns fighting as one: unlocks Infantry and the Tank.", cost: { iron: 4000, food: 150000 }, baseSeconds: 18000, effect: { attack: 0.3, defense: 0.2 } },
  { id: "ballistics", name: "Ballistics", age: 6, description: "Fire control for long guns: unlocks Artillery.", cost: { iron: 2000, stone: 40000 }, baseSeconds: 10800, requires: ["combined_arms"] },
  { id: "synthetic_fertilizer", name: "Synthetic fertilizer", age: 6, description: "Nitrogen from the air: fields yield half as much again.", cost: { iron: 1500, food: 100000 }, baseSeconds: 14400, effect: { yield: { food: 0.3 } } },
];

export const buildingById = new Map(BUILDINGS.map((b) => [b.id, b]));
export const unitById = new Map(UNITS.map((u) => [u.id, u]));
export const techById = new Map(TECHS.map((t) => [t.id, t]));
