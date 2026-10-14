import { balance } from "../config/balance.js";
import { unitById } from "../config/ages.js";
import { seededRng } from "./rng.js";

export type UnitCounts = Record<string, number>;

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
export function carryCapacity(units: UnitCounts): number {
  let c = 0;
  for (const [id, n] of Object.entries(units)) c += n * (unitById.get(id)?.carry ?? 0);
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
