/**
 * Every tunable "starting value" from the spec lives here and nowhere else.
 * Milestones add sections; nothing numeric about game balance is hard-coded
 * elsewhere in the codebase.
 *
 * Rates are expressed per GAME HOUR. Real seconds convert to game hours via
 * the match speed multiplier (see rules/time.ts), so a 10x match produces ten
 * times faster in real time.
 */
export const balance = {
  match: {
    /** Real matches run at 1x; the friends test runs at 10x. Immutable after a match starts. */
    defaultSpeed: 1,
    testSpeed: 10,
    lengthDays: 30,
    maxHumanPlayers: 100,
    /** Days of beginner protection after a match starts (spec: 3 to 5). */
    protectionDays: 4,
    /** How many candidate starting regions a joining player is offered. */
    startOptions: 6,
    /** Minimum great-circle distance between two players' capitals, in km. */
    minCapitalSpacingKm: 900,
  },
  start: {
    families: 5,
    /** People per family at match start. */
    peoplePerFamily: 4,
    food: 250,
    wood: 200,
    stone: 100,
    /** Default worker split for a fresh capital. Shares sum to 1. */
    assignment: { food: 0.35, wood: 0.4, stone: 0.25 },
  },
  economy: {
    /** Base output per worker per game hour before terrain and resource modifiers. */
    perWorkerPerHour: { food: 10, wood: 16, stone: 10 },
    /** Terrain multipliers on gathering. Missing key means 1.0. */
    terrain: {
      plains: { food: 1.25, wood: 0.8, stone: 0.8 },
      forest: { food: 0.9, wood: 1.5, stone: 0.7 },
      hills: { food: 0.85, wood: 0.9, stone: 1.4 },
      mountains: { food: 0.5, wood: 0.7, stone: 1.8 },
      desert: { food: 0.4, wood: 0.4, stone: 1.0 },
      tundra: { food: 0.45, wood: 0.5, stone: 0.8 },
      wetland: { food: 1.1, wood: 0.9, stone: 0.4 },
    } as Record<string, { food: number; wood: number; stone: number }>,
    /** Special-resource multipliers on gathering. */
    resourceBonus: {
      fertile_soil: { food: 1.3 },
      fish: { food: 1.15 },
      timber: { wood: 1.4 },
      stone_quarry: { stone: 1.5 },
    } as Record<string, Partial<{ food: number; wood: number; stone: number }>>,
    coastalFoodBonus: 1.1,
    riverFoodBonus: 1.1,
    /** Food eaten per person per game hour. */
    foodPerPersonPerHour: 0.4,
    /** Soldiers eat this many times a worker's ration: armies are a real food sink. */
    soldierFoodMultiplier: 3,
    /** Population growth per game hour as a fraction of current population, when fed. */
    growthPerHour: 0.08,
    /** Newcomers per game hour that arrive in any fed region with room, so small colonies take off too. */
    arrivalsPerHour: 1.5,
    /** Growth slows to zero as population approaches the region's capacity. */
    baseCapacity: 50,
    /** Population lost per game hour as a fraction of current population while starving. */
    starvationPerHour: 0.01,
    /** Population lost per game hour in a frozen region: the ice is not survivable. */
    frozenDeathPerHour: 0.1,
    /** Storage cap for each base resource in a region with no storage buildings. */
    baseStorage: { food: 1500, wood: 1200, stone: 1000 },
    /** The capital's storage caps are multiplied by this: it is where surplus from every region ends up. */
    capitalStorageMult: 3,
    /** Cap for each metal/horse stock per region. */
    specialStorage: 1000,
    /** Settle sub-step in game minutes. Smaller is more accurate and slower. */
    settleStepMinutes: 5,
    /** Beyond this many sub-steps a single settle snaps the remainder in one coarse step. */
    settleMaxSteps: 20_000,
  },
  queue: {
    slotsPerRegion: 10,
    /** Techs a player may have queued at once (one researches at a time). */
    researchSlots: 10,
  },
  timers: {
    /** Each building level multiplies build time by this. */
    levelGrowth: 1.55,
    /** Each building level multiplies cost by this. */
    costGrowth: 1.65,
    /** Longest any single action may take, in game seconds (spec: 8 to 12 hours). */
    maxSeconds: 10 * 3600,
    /** Training N units takes baseSeconds * N^batchExponent. */
    batchExponent: 0.8,
    /** Fraction refunded when cancelling a job that has already started (1 = full refund, same as unstarted). */
    cancelRefundStarted: 1,
    /**
     * Building and research costs grow with the match day so income stays
     * useful all month: linear between these points (day -> multiplier).
     * Unit costs use the square root of the same curve.
     */
    dayCost: [
      { day: 0, mult: 1 },
      { day: 15, mult: 4 },
      { day: 30, mult: 8 },
    ],
  },
  travel: {
    /** Unit speed (km per game hour in the tables) is multiplied by this to get map km per hour. */
    speedScale: 50,
    /** Minimum trip in game seconds, so adjacent regions still take a moment. */
    minSeconds: 300,
    /** Terrain of the region being entered multiplies the leg's distance. */
    terrain: {
      plains: 1.0,
      forest: 1.15,
      hills: 1.25,
      mountains: 1.7,
      desert: 1.3,
      tundra: 1.4,
      wetland: 1.35,
    } as Record<string, number>,
    /** Entering a coastal or river region is faster. */
    waterwayFactor: 0.85,
    /** A leg is this much shorter when both ends have Roads (yours or an ally's), and this much when only one end does. */
    roadBothFactor: 0.6,
    roadOneFactor: 0.8,
    /** A leg between two Railway regions (yours or an ally's) is this much shorter. */
    railBothFactor: 0.3,
    /** Sea legs are fast once boats exist. */
    seaFactor: 0.7,
    /** Tech that allows armies to use sea routes. */
    seaTech: "shipbuilding",
    /** Goods each travelling person can carry on moves, reinforcements and evacuations. */
    carryPerPerson: 20,
  },
  combat: {
    maxRounds: 6,
    /** Hit points per point of (attack + defense). */
    hpPerStat: 2,
    /** Damage dealt per point of strength per round. */
    damagePerStrength: 1.0,
    /** +-variance applied to each side's strength per round (0.3 = +-15 %). */
    variance: 0.3,
    /** Defensive bonus for terrain of the defended region. */
    terrainDefense: { hills: 0.15, mountains: 0.35, forest: 0.1, wetland: 0.1 } as Record<string, number>,
    /** Unarmed population defends a little: this many warrior-equivalents per 10 people. */
    militiaPerTenPeople: 0.5,
    /** Soldiers lost while a raid is repelled do not take the loot; winners take up to this share of unprotected stock. */
    raidShare: 0.5,
  },
  tribute: {
    /** Highest share of a region's production a share-mode trade route may carry away. */
    maxShare: 0.5,
  },
  trade: {
    /** When a route finds no caravans at its origin, idle caravans from the nearest other region come over. */
    fetchCaravans: true,
    /** A region whose stock hits its cap sends this share of the cap to the capital by caravan, automatically. */
    overflowToCapital: true,
    overflowShare: 0.25,
    /** Upgrading one hauler into the next kind costs this per unit (on top of needing the tech). */
    convertCost: {} as Record<string, Record<string, number>>,
    /** Finishing these techs rebuilds the whole fleet (at home or on the road) as the better hauler. */
    fleetUpgradeTech: { wagon_building: { from: "caravan", to: "wagon" }, railways: { from: "wagon", to: "train" } } as Record<string, { from: string; to: string }>,
    /** Techs that raise how much each hauler carries (added together: +50% and +50% = 2x). */
    caravanCarryTechs: { the_wheel: 0.5, engineering: 0.5, scholasticism: 1.0 } as Record<string, number>,
  },
  capital: {
    /** The capital wagon: slow, but it carries the old capital's stores to the new one. Speed in unit-speed units (settlers are 4). */
    wagonSpeed: 2.5,
    wagonCarry: 25000,
  },
  settle: {
    /** Settlers needed to claim an empty region; all of them become its first workers. */
    settlersRequired: 5,
    /** Settled regions start loyal: these are your own people. */
    startingLoyalty: 0.8,
    seedFood: 120,
  },
  conquest: {
    /** People an army must carry to occupy a conquered region. */
    occupiersRequired: 5,
    /** Supplies the occupiers bring with them so they do not starve on day one. */
    seedFood: 80,
    /** Loyalty of a freshly conquered region (0..1). Rebellion risk below `rebelBelow`. */
    startingLoyalty: 0.4,
    rebelBelow: 0.3,
    /** Loyalty drifts toward this target per game hour by `loyaltyRate`. */
    loyaltyRate: 0.01,
    /** Target loyalty falls with distance from the capital: 1 - km / distanceScaleKm, floored at 0. */
    distanceScaleKm: 6000,
    /** Chance per tick (balance.tick.minutes) that a disloyal region rebels. */
    rebelChancePerTick: 0.08,
    /** Occupiers needed per 100 people in a conquered region to keep it quiet. */
    occupiersPerHundred: 10,
    /** A Temple turns this many of the region's workers into occupiers per game hour, until the need is met. */
    templeConvertsPerHour: 2,
  },
  schedule: {
    /** The worker keeps one upcoming weekly lobby open when enabled. */
    enabled: true,
    /** 0 = Sunday ... 6 = Saturday. */
    weekday: 1,
    hourUtc: 0,
  },
  fairplay: {
    /** How often the worker scans for multi-account signals, in real minutes. */
    scanMinutes: 60,
  },
  ice: {
    /** Production multiplier left when the ice line reaches a region's centre (taper from the pole-facing tip). */
    taperFloor: 0.25,
    /** Absolute latitude of the ice edge by match day; interpolated between points. */
    schedule: [
      { day: 0, latitude: 72 },
      { day: 7, latitude: 62 },
      { day: 14, latitude: 52 },
      { day: 21, latitude: 42 },
      { day: 28, latitude: 32 },
      { day: 30, latitude: 28 },
    ],
  },
  tick: {
    /** Match tick cadence in real minutes (loyalty, AI, score, win check). */
    minutes: 5,
  },
  ai: {
    /** AI tribes are added at match start until this many players exist (spec: up to 100). */
    fillTo: 24,
    /** Neutral tribes scattered on the map at match start. */
    neutralTribes: 60,
    /** Neutral tribes are not placed within this distance of any capital. */
    neutralMinDistanceKm: 500,
    neutralPeople: { min: 12, max: 40 },
    /** Ore a neutral tribe holds (one of copper, tin, iron), so raiding them is a way into the next age. */
    neutralOre: { min: 15, max: 45 },
    /** AI tribes list ore on the market once they hold more than this, asking this much wood per unit. */
    oreListAbove: 40,
    oreAskWoodPerUnit: 12,
    /** AI tribes start colonizing once a region has this many workers. */
    settleAbove: 40,
    /** AI tribes keep this many caravans per region once stores pass 85% of a cap (hard tribes one more). */
    caravansPerRegion: 2,
    neutralWarriors: { min: 2, max: 10 },
    /** Neutral tribes train a few warriors per game day so the map never feels empty. */
    neutralGrowthWarriorsPerDay: 1.5,
    /** Share of AI tribes at each difficulty when a match is created as "mixed". */
    difficultyMix: { easy: 0.4, medium: 0.4, hard: 0.2 },
    /** Share of population an AI keeps as soldiers, by profile. */
    soldierShare: { peaceful: 0.12, balanced: 0.2, raider: 0.3 } as Record<string, number>,
    /** Chance per decision to launch a raid, by profile. */
    raidChance: { peaceful: 0.05, balanced: 0.15, raider: 0.35 } as Record<string, number>,
    /** Chance per decision to try a conquest of a neutral neighbour. */
    conquerChance: { peaceful: 0.1, balanced: 0.2, raider: 0.25 } as Record<string, number>,
    /** AI never attacks players whose army total exceeds this multiple of its own. */
    maxTargetStrengthRatio: 0.8,
    names: [
      "Ashfolk", "Brightwater", "Coldspring", "Dunmere", "Elkridge", "Fenwick", "Greyhollow", "Hartland", "Ironvale", "Juniper",
      "Kestrel", "Longmoor", "Marrowgate", "Nightfell", "Oakenshaw", "Pinecrest", "Quillmark", "Ravensholt", "Stonebrook", "Thornfield",
      "Umberlake", "Vellmoor", "Wildmarch", "Yarrowdale", "Zephyr", "Alderwood", "Blackfen", "Copperhill", "Driftmoor", "Emberfall",
    ],
  },
  win: {
    regionShareForEarlyWin: 0.6,
    holdHours: 48,
    /** Score = regions * territory + population * population + age * age (per player). */
    scoreWeights: { territory: 25, population: 1, age: 150 },
  },
} as const;

export type Balance = typeof balance;
