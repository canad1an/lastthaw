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
    food: 120,
    wood: 60,
    stone: 20,
    /** Default worker split for a fresh capital. Shares sum to 1. */
    assignment: { food: 0.6, wood: 0.25, stone: 0.15 },
  },
  economy: {
    /** Base output per worker per game hour before terrain and resource modifiers. */
    perWorkerPerHour: { food: 1.0, wood: 0.6, stone: 0.35 },
    /** Terrain multipliers on gathering. Missing key means 1.0. */
    terrain: {
      plains: { food: 1.25, wood: 0.6, stone: 0.8 },
      forest: { food: 0.9, wood: 1.5, stone: 0.7 },
      hills: { food: 0.85, wood: 0.9, stone: 1.4 },
      mountains: { food: 0.5, wood: 0.7, stone: 1.8 },
      desert: { food: 0.4, wood: 0.3, stone: 1.0 },
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
    foodPerPersonPerHour: 0.08,
    /** Population growth per game hour as a fraction of current population, when fed. */
    growthPerHour: 0.004,
    /** Growth slows to zero as population approaches the region's capacity. */
    baseCapacity: 60,
    /** Population lost per game hour as a fraction of current population while starving. */
    starvationPerHour: 0.01,
    /** Storage cap for each base resource in a region with no storage buildings. */
    baseStorage: { food: 600, wood: 400, stone: 300 },
    /** Cap for each metal/horse stock per region. */
    specialStorage: 500,
    /** Settle sub-step in game minutes. Smaller is more accurate and slower. */
    settleStepMinutes: 5,
    /** Beyond this many sub-steps a single settle snaps the remainder in one coarse step. */
    settleMaxSteps: 20_000,
  },
  queue: {
    slotsPerRegion: 3,
  },
  timers: {
    /** Each building level multiplies build time by this. */
    levelGrowth: 1.45,
    /** Each building level multiplies cost by this. */
    costGrowth: 1.5,
    /** Longest any single action may take, in game seconds (spec: 8 to 12 hours). */
    maxSeconds: 10 * 3600,
    /** Training N units takes baseSeconds * N^batchExponent. */
    batchExponent: 0.8,
    /** Full refund when cancelling a job that has not started; this fraction once it has. */
    cancelRefundStarted: 0.5,
  },
  win: {
    regionShareForEarlyWin: 0.6,
    holdHours: 48,
    scoreWeights: { territory: 1, population: 1, age: 1 },
  },
} as const;

export type Balance = typeof balance;
