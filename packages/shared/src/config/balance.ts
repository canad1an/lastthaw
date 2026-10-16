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
    /** Fastest a player-made game may run: 180x is the whole 30 days in about four hours. */
    maxGameSpeed: 180,
    /** Most AI tribes a game may be filled with. */
    maxAiTribes: 20,
    /** Real matches run at 1x; the friends test runs at 10x. Immutable after a match starts. */
    defaultSpeed: 1,
    testSpeed: 10,
    lengthDays: 30,
    /** Beta: twenty humans a match. */
    maxHumanPlayers: 20,
    /** Days of beginner protection after a match starts (spec: 3 to 5). */
    protectionDays: 4,
    /** How many candidate starting regions a joining player is offered. */
    startOptions: 6,
    /** Minimum great-circle distance between two players' capitals, in km. */
    minCapitalSpacingKm: 900,
    /** Capitals are offered no further from the equator than this; the ice ends at 28°, so a start beyond 40° is a lost cause. */
    maxStartLatitude: 40,
  },
  start: {
    families: 5,
    /** People per family at match start. */
    peoplePerFamily: 4,
    food: 250,
    wood: 200,
    stone: 100,
    /** Default worker split for a fresh capital. Shares sum to 1. */
    assignment: { food: 0.3, wood: 0.4, stone: 0.3 },
  },
  economy: {
    /** Base output per worker per game hour before terrain and resource modifiers. */
    perWorkerPerHour: { food: 10, wood: 16, stone: 12 },
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
    /** Food eaten per person per game hour. Roughly a third of a worker's food output, so feeding a people is a real share of the work. */
    foodPerPersonPerHour: 1.2,
    /** Soldiers eat this many times a worker's ration: armies are a real food sink. */
    soldierFoodMultiplier: 3,
    /** Population growth per game hour as a fraction of current population, when fed. */
    growthPerHour: 0.08,
    /** Newcomers per game hour that arrive in any fed region with room, so small colonies take off too. */
    arrivalsPerHour: 1.5,
    /** Growth slows to zero as population approaches the region's capacity. */
    baseCapacity: 50,
    /** Share of the people above capacity who leave for a neighbouring region of yours with room, per game hour. */
    migrationPerHour: 0.1,
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
    /** From this level on, cost and time grow faster still, so high levels are the late-game sink instead of an idle queue. */
    lateLevel: 6,
    lateCostGrowth: 1.15,
    lateTimeGrowth: 1.3,
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
    /** A sea leg is this much shorter with a Harbour (yours or an ally's) at both ends, or at one end. */
    harborBothFactor: 0.5,
    harborOneFactor: 0.75,
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
    /**
     * Walls are exceptionally strong against men alone. Every siege point the attacker brings (catapults, cannon, tanks, artillery)
     * knocks the wall bonus down; at `breach` points the wall counts for nothing. Techs and terrain are never breached.
     */
    wallBreach: { palisade: 10, walls: 30, fort: 40, castle: 80, arsenal: 120, bunker: 200 } as Record<string, number>,
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
  naval: {
    /** A patrol holds its lane for this many game hours, then sails home. */
    patrolHours: 12,
    /** Which missions may carry ships: ships only ever sail one lane, coast to coast. */
    maxSeaLegs: 1,
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
  /** The AI tribes talk on Discord during tournaments: this many posts each per match, on days fixed by the seed. */
  discord: {
    /** Posts per tribe per match, on Discord during tournaments and in the match chat in every match (separate schedules). */
    postsPerTribe: { min: 1, max: 10 },
    /** A battle is worth talking about when a region changed hands or at least this many units died on both sides together. */
    battleLossesToTalk: 8,
    /** Chance a tribe comments on a major battle it was in (once a day at most). */
    battleTalkChance: 0.6,
  },
  schedule: {
    /** The worker keeps this many upcoming weekly lobbies open when enabled, each with a name of its own. */
    enabled: true,
    upcoming: 6,
    /** Tournaments take registrations from the start; joining (and the lobby itself) opens this many hours before the start. */
    joinOpensHours: 1,
    /** 0 = Sunday ... 6 = Saturday. */
    weekday: 1,
    hourUtc: 0,
  },
  fairplay: {
    /** How often the worker scans for multi-account and automation signals, in real minutes. */
    scanMinutes: 60,
    /** Commands (builds, orders, moves, trades) a player may send per minute; no hand gets near it, a loop does. */
    commandsPerMinute: 40,
    /** Automation signals need at least this many commands in a day to mean anything. */
    automationMinActions: 60,
    /** Intervals between commands this regular (standard deviation over mean) look scripted. */
    automationRegularity: 0.3,
    /** Commands in this many distinct hours of one day look like nobody sleeps. */
    automationActiveHours: 20,
    /** Command rows are kept this many days for the scan. */
    actionRetentionDays: 7,
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
    /** Match tick cadence in real minutes at 1x (loyalty, AI, score, win check); faster matches tick proportionally more often, never more than once per `minSeconds`. */
    minutes: 5,
    minSeconds: 10,
  },
  ai: {
    /** AI tribes are added at match start until this many players exist (spec: up to 100). */
    fillTo: 20,
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
    /** AI tribes only queue a build that waits on materials when the shortfall is at most this much (a few hauler loads). */
    maxWaitingShipment: 6000,
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
    /** From this day hard raiders prefer weak land held by other players to empty land, and accept slightly stronger defenders. */
    conquerPlayersFromDay: 15,
    /** A tribute demand asks for this share of the victim's capital stock (between `tributeMin` and `tributeMax`), which a reasonable tribe pays. */
    tributeShare: 0.08,
    tributeMin: 100,
    tributeMax: 5000,
    names: [
      "Ashfolk", "Brightwater", "Coldspring", "Dunmere", "Elkridge", "Fenwick", "Greyhollow", "Hartland", "Ironvale", "Juniper",
      "Kestrel", "Longmoor", "Marrowgate", "Nightfell", "Oakenshaw", "Pinecrest", "Quillmark", "Ravensholt", "Stonebrook", "Thornfield",
      "Umberlake", "Vellmoor", "Wildmarch", "Yarrowdale", "Zephyr", "Alderwood", "Blackfen", "Copperhill", "Driftmoor", "Emberfall",
    ],
  },
  /** World events: everything that happens to a player rather than because of one. */
  events: {
    /** Blizzards: a day's warning, then production halves and travel doubles across a wide band for `hours`. */
    storm: { chance: 0.35, fromDay: 3, radiusKm: 1200, warningHours: 24, hours: 12, production: 0.5, travel: 2 },
    /** Thaw pockets: a region that should freeze stays open `extraDays` longer, at most `max` times a match. */
    thaw: { fromDay: 10, toDay: 27, chance: 0.3, max: 2, extraDays: 3 },
    /** Plague: a region over `crowding` × capacity may fall sick; no growth and `deathPerHour` of its people lost for `hours`. */
    plague: { crowding: 1.2, chance: 0.25, hours: 48, deathPerHour: 0.02 },
    /** Migrant columns: this share of a freezing region's people reach the nearest empire within `hops`, who has `hours` to take them in. */
    refugees: { share: 0.6, hops: 2, hours: 24, foodPerPerson: 20 },
    /** The Northern Horde: from `fromDay`, raids out of the ice line against the richest region in reach. */
    horde: { fromDay: 14, chance: 0.5, lateDay: 21, lateChance: 0.8, base: 20, perDay: 6, catapultsFromDay: 18, bandDeg: 6, reachKm: 1500, name: "The Northern Horde" },
    /** Rich finds: a mine, quarry or camp doubles its output for `hours`, and the neighbours hear. */
    boom: { chance: 0.4, hours: 48, mult: 2 },
    /** Expeditions: three or more hops into the unknown with three or more soldiers; outcome odds must sum to 1. */
    expedition: { minHops: 3, minSoldiers: 3, artifact: 0.4, hoard: 0.3, tale: 0.2, ambush: 0.1, hoardIronPerAge: 300, taleHours: 48, taleLoyalty: 0.15, ambushLoss: 0.5 },
    /** Pacts stop raids both ways; notice to end one; ceasefires are fixed; tribute has a deadline, refusal opens a window of double loot. */
    diplomacy: { napNoticeHours: 24, ceasefireHours: 48, tributeHours: 24, tributeCooldownHours: 72, causeForWarHours: 24, lootMult: 2 },
    /** Mercenary companies: offered now and then, hired for iron, gone again after `hours`. */
    mercenaries: { chance: 0.5, offerHours: 12, hours: 48, ironPerUnit: { sellsword: 12, free_company: 30 } },
    /** The last stand: once, when the ice is a day from the capital, everything marches south at double speed. */
    lastStand: { withinDays: 1, speedMult: 2 },
    /** Daily objectives: the match's score leader competes at this fraction of their value, so the prize spreads around. */
    objective: { leaderHandicap: 0.6 },
    /** Bounties: a rebel region is worth `rebelPerValue` x its value in each of food, wood and stone; a horde camp pays `hordeCamp`; a refused tribute puts `tributeShare` of the refuser's capital stock on their head for `tributeHours`. */
    bounty: { rebelPerValue: 10, hordeCamp: { food: 300, wood: 200, stone: 150 } as Record<string, number>, tributeShare: 0.05, tributeHours: 24 },
  },
  win: {
    regionShareForEarlyWin: 0.6,
    holdHours: 48,
    /** Score = regions * territory + population * population + age * age (per player). */
    scoreWeights: { territory: 25, population: 1, age: 150 },
    /** Day 30, the ice stops: the player with the most people alive in unfrozen land wins. Rank below the winner is by score. */
    survival: true,
    /** Bonus score for being first in the match to reach a checkpoint. Keys: age_<n>, harbor, train, temple, wonder. */
    milestones: { age: 200, harbor: 100, train: 150, temple: 100, wonder: 300, daily: 100 } as Record<string, number>,
    /** Finishing this building wins the match outright. */
    wonderBuilding: "great_hearth",
  },
} as const;

export type Balance = typeof balance;
