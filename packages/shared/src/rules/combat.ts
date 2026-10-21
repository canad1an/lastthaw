import { balance } from "../config/balance.js";
import { UNITS, unitById, buildingById } from "../config/ages.js";
import { seededRng } from "./rng.js";

export type UnitCounts = Record<string, number>;

/**
 * The chance one scout is caught in a region. `held`: someone owns it. `soldiers`: fighting units standing there.
 * `watchtower`: a tower in the region or in a neighbour of the same owner. `wall`: any wall line.
 * Nobody is caught where nobody is: an unheld region with no soldiers is safe.
 */
export function scoutCatchChance(o: { held: boolean; soldiers: number; watchtower: boolean; wall: boolean }): number {
  const s = balance.scouting;
  if (!o.held && o.soldiers <= 0) return 0;
  let c = s.catchBase + Math.floor(Math.max(0, o.soldiers) / 10) * s.catchPerTenSoldiers + (o.wall ? s.wallBonus : 0);
  if (o.watchtower) c *= s.watchtowerMult;
  return Math.min(s.catchCap, c);
}

/** Fighting units in a region: everything that is not a civilian or a hauler. */
export function soldierCount(units: UnitCounts): number {
  let n = 0;
  for (const [id, q] of Object.entries(units)) {
    const d = unitById.get(id);
    if (d && !d.civilian && !d.hauler) n += q;
  }
  return n;
}

export interface CombatSide {
  units: UnitCounts;
  /** Multiplicative bonus on strength (e.g. 0.25 for +25 %). */
  bonus: number;
}

export interface CombatResult {
  attackerWon: boolean;
  rounds: number;
  attackerLosses: UnitCounts;
  defenderLosses: UnitCounts;
  attackerRemaining: UnitCounts;
  defenderRemaining: UnitCounts;
  seed: string;
}

function strength(units: UnitCounts, stat: "attack" | "defense"): number {
  let s = 0;
  for (const [id, n] of Object.entries(units)) {
    const def = unitById.get(id);
    if (def && n > 0) s += n * def[stat];
  }
  return s;
}

function hitPoints(units: UnitCounts): number {
  let hp = 0;
  for (const [id, n] of Object.entries(units)) {
    const def = unitById.get(id);
    if (def && n > 0) hp += n * (def.attack + def.defense) * balance.combat.hpPerStat;
  }
  return hp;
}

function count(units: UnitCounts): number {
  return Object.values(units).reduce((a, b) => a + b, 0);
}

/** Remove `fraction` of every unit type (rounded toward killing whole units, never below zero). */
function applyLosses(units: UnitCounts, fraction: number): { remaining: UnitCounts; losses: UnitCounts } {
  const remaining: UnitCounts = {};
  const losses: UnitCounts = {};
  for (const [id, n] of Object.entries(units)) {
    const lost = Math.min(n, Math.ceil(n * fraction - 1e-9));
    losses[id] = lost;
    remaining[id] = n - lost;
  }
  return { remaining, losses };
}

/**
 * Deterministic auto-resolved battle. Attackers fight with their attack stat,
 * defenders with their defense stat times their fortification bonus. Each
 * round both sides deal damage simultaneously; the side that loses the larger
 * share of its hit points loses the round, and the battle ends when one side
 * is wiped out or the round limit is reached.
 */
export function resolveCombat(attacker: CombatSide, defender: CombatSide, seed: string): CombatResult {
  const rng = seededRng(seed);
  const c = balance.combat;
  let a = { ...attacker.units };
  let d = { ...defender.units };
  const aLoss: UnitCounts = {};
  const dLoss: UnitCounts = {};
  let rounds = 0;

  if (count(d) === 0) {
    return { attackerWon: count(a) > 0, rounds: 0, attackerLosses: {}, defenderLosses: {}, attackerRemaining: a, defenderRemaining: d, seed };
  }

  for (rounds = 1; rounds <= c.maxRounds; rounds++) {
    const aStr = strength(a, "attack") * (1 + attacker.bonus) * (1 + (rng() - 0.5) * c.variance);
    const dStr = strength(d, "defense") * (1 + defender.bonus) * (1 + (rng() - 0.5) * c.variance);
    const aHp = hitPoints(a);
    const dHp = hitPoints(d);
    if (aHp <= 0 || dHp <= 0) break;
    const dFrac = Math.min(1, (aStr * c.damagePerStrength) / dHp);
    const aFrac = Math.min(1, (dStr * c.damagePerStrength) / aHp);
    const dr = applyLosses(d, dFrac);
    const ar = applyLosses(a, aFrac);
    d = dr.remaining;
    a = ar.remaining;
    for (const [k, v] of Object.entries(dr.losses)) dLoss[k] = (dLoss[k] ?? 0) + v;
    for (const [k, v] of Object.entries(ar.losses)) aLoss[k] = (aLoss[k] ?? 0) + v;
    if (count(a) === 0 || count(d) === 0) break;
  }

  const aLeft = count(a) / Math.max(1, count(attacker.units));
  const dLeft = count(d) / Math.max(1, count(defender.units));
  const attackerWon = count(d) === 0 || (count(a) > 0 && aLeft > dLeft);
  return { attackerWon, rounds: Math.min(rounds, c.maxRounds), attackerLosses: aLoss, defenderLosses: dLoss, attackerRemaining: a, defenderRemaining: d, seed };
}

/** Total loot an army can carry home. */
/** Hauler unit ids, best (largest carry) first. */
export const HAULER_IDS: readonly string[] = UNITS.filter((u) => u.hauler).sort((a, b) => b.carry - a.carry).map((u) => u.id);

/** How much one hauler of this kind carries, after the owner's techs. */
export function haulerCarry(id: string, techs?: ReadonlySet<string> | readonly string[]): number {
  const base = unitById.get(id)?.carry ?? 0;
  if (!techs) return base;
  const has = techs instanceof Set ? (t: string) => techs.has(t) : (t: string) => (techs as readonly string[]).includes(t);
  let bonus = 0;
  for (const [tech, b] of Object.entries(balance.trade.caravanCarryTechs)) if (has(tech)) bonus += b;
  return Math.round(base * (1 + bonus));
}

/** How much one caravan carries, after the owner's techs. */
export function caravanCarry(techs?: ReadonlySet<string> | readonly string[]): number {
  return haulerCarry("caravan", techs);
}

/** Siege points in an army: the sum of every unit's breach value. */
export function breachOf(units: UnitCounts): number {
  let b = 0;
  for (const [id, n] of Object.entries(units)) b += (unitById.get(id)?.breach ?? 0) * Math.max(0, n);
  return b;
}

/**
 * The defence bonus a region's walls give against `attackers`: each wall's bonus,
 * scaled down by how much of its breach threshold the attacker's siege engines reach.
 * No siege engines: the walls stand in full. Enough of them: the walls count for nothing.
 */
export function wallBonusAgainst(buildings: Record<string, number>, attackers: UnitCounts): number {
  const siege = breachOf(attackers);
  let bonus = 0;
  for (const [id, need] of Object.entries(balance.combat.wallBreach)) {
    if ((buildings[id] ?? 0) < 1) continue;
    const def = buildingById.get(id);
    const full = (def?.effect.defense ?? 0) * (buildings[id] ?? 0);
    bonus += full * Math.max(0, 1 - siege / need);
  }
  return bonus;
}

/** The best hauler kind stationed in `units`, or null. Ships only count when the trip is a single sea lane. */
export function bestHauler(units: UnitCounts, allowNaval = false): string | null {
  for (const id of HAULER_IDS) {
    if ((units[id] ?? 0) <= 0) continue;
    if (!allowNaval && unitById.get(id)?.naval) continue;
    return id;
  }
  return null;
}

/** Split an army into its ships and everything else. */
export function splitNaval(units: UnitCounts): { ships: UnitCounts; rest: UnitCounts } {
  const ships: UnitCounts = {};
  const rest: UnitCounts = {};
  for (const [id, n] of Object.entries(units)) {
    if (n <= 0) continue;
    if (unitById.get(id)?.naval) ships[id] = n;
    else rest[id] = n;
  }
  return { ships, rest };
}

/** Total haulers of every kind in `units`. */
export function haulerCount(units: UnitCounts): number {
  return HAULER_IDS.reduce((a, id) => a + (units[id] ?? 0), 0);
}

export function carryCapacity(units: UnitCounts, techs?: ReadonlySet<string> | readonly string[]): number {
  let c = 0;
  for (const [id, n] of Object.entries(units)) c += n * (unitById.get(id)?.hauler ? haulerCarry(id, techs) : (unitById.get(id)?.carry ?? 0));
  return c;
}

/** Slowest unit in the army sets the pace, in km per game hour. */
export function armySpeed(units: UnitCounts): number {
  let s = Infinity;
  for (const [id, n] of Object.entries(units)) {
    if (n <= 0) continue;
    const def = unitById.get(id);
    if (def) s = Math.min(s, def.speed);
  }
  return s === Infinity ? 0 : s;
}

/** Materials convoys a player may have on the road at once: the base cap, or one for every supplyConvoysPerHaulers haulers owned, whichever is more. */
export function supplyConvoyCap(haulers: number): number {
  return Math.max(balance.trade.maxSupplyConvoys, Math.floor(Math.max(0, haulers) / balance.trade.supplyConvoysPerHaulers));
}
