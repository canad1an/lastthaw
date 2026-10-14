/**
 * Every tunable "starting value" from the spec lives here and nowhere else.
 * Milestones add sections; nothing numeric about game balance is hard-coded
 * elsewhere in the codebase.
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
  },
  start: {
    families: 5,
    /** People per family at match start. */
    peoplePerFamily: 4,
    food: 100,
    wood: 50,
    stone: 20,
  },
  queue: {
    slotsPerRegion: 3,
  },
  win: {
    regionShareForEarlyWin: 0.6,
    holdHours: 48,
    scoreWeights: { territory: 1, population: 1, age: 1 },
  },
} as const;

export type Balance = typeof balance;
