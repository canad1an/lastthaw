import { balance } from "../config/balance.js";
import { seededRng } from "./rng.js";

export type UnitLosses = Record<string, number>;
/** One round of the playback: what the attacker loses, what the defender loses. */
export type BattleRound = [attacker: UnitLosses, defender: UnitLosses];

const total = (u: UnitLosses) => Object.values(u).reduce((a, b) => a + b, 0);

/**
 * Spread a decided battle's casualties over many short rounds so it can be watched: one unit a round, two when the
 * fight is big, and just enough per round to finish inside `balance.battle.maxRounds` when it is enormous. The two
 * sides fall in proportion to their losses, and within a side the unit types in proportion to theirs, from a seeded
 * draw, so the same battle always plays back the same way. The sum of every round is exactly the losses given.
 */
export function battleSchedule(attackerLosses: UnitLosses, defenderLosses: UnitLosses, seed: string): BattleRound[] {
  const aTotal = total(attackerLosses);
  const dTotal = total(defenderLosses);
  const all = aTotal + dTotal;
  if (all <= 0) return [];
  const max = balance.battle.maxRounds;
  const perRound = all <= max ? 1 : all <= 2 * max ? 2 : Math.ceil(all / max);
  const rng = seededRng(`${seed}:playback`);
  const remA: UnitLosses = { ...attackerLosses };
  const remD: UnitLosses = { ...defenderLosses };
  let leftA = aTotal;
  let leftD = dTotal;
  const draw = (rem: UnitLosses): string => {
    const live = Object.entries(rem).filter(([, n]) => n > 0);
    const sum = live.reduce((a, [, n]) => a + n, 0);
    let r = rng() * sum;
    for (const [id, n] of live) {
      r -= n;
      if (r < 0) return id;
    }
    return live[live.length - 1]![0];
  };
  const out: BattleRound[] = [];
  while (leftA + leftD > 0) {
    const a: UnitLosses = {};
    const d: UnitLosses = {};
    for (let k = 0; k < perRound && leftA + leftD > 0; k++) {
      const attackerFalls = rng() < leftA / (leftA + leftD);
      if (attackerFalls) {
        const id = draw(remA);
        remA[id]! -= 1;
        leftA -= 1;
        a[id] = (a[id] ?? 0) + 1;
      } else {
        const id = draw(remD);
        remD[id]! -= 1;
        leftD -= 1;
        d[id] = (d[id] ?? 0) + 1;
      }
    }
    out.push([a, d]);
  }
  return out;
}
