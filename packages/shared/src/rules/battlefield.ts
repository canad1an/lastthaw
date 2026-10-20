import { unitById } from "../config/ages.js";
import { seededRng } from "./rng.js";

/**
 * The battle window's cast: one figure per unit (or per k units in a big fight) laid out in ranks, and which figure
 * falls in which round. It is a pure function of the battle id, the two starting armies and the round log, so every
 * viewer, whenever they open the window, sees the same men fall.
 */

export type FigureCat = "foot" | "horse" | "ranged" | "siege" | "civil";
export type FigureWeapon = "club" | "axe" | "sword" | "spear" | "bow" | "sling" | "gun" | "none" | "catapult" | "cannon";
export interface FigureLook {
  cat: FigureCat;
  weapon: FigureWeapon;
  shield?: boolean;
  helm?: boolean;
}

const LOOKS: Record<string, FigureLook> = {
  warrior: { cat: "foot", weapon: "club" },
  tracker: { cat: "foot", weapon: "club" },
  militia: { cat: "foot", weapon: "axe" },
  sellsword: { cat: "foot", weapon: "sword", helm: true },
  free_company: { cat: "foot", weapon: "sword", shield: true, helm: true },
  spearman: { cat: "foot", weapon: "spear", shield: true, helm: true },
  swordsman: { cat: "foot", weapon: "sword", shield: true, helm: true },
  legionary: { cat: "foot", weapon: "sword", shield: true, helm: true },
  chariot: { cat: "horse", weapon: "spear" },
  cavalry: { cat: "horse", weapon: "spear" },
  cataphract: { cat: "horse", weapon: "spear", helm: true },
  knight: { cat: "horse", weapon: "spear", helm: true },
  slinger: { cat: "ranged", weapon: "sling" },
  archer: { cat: "ranged", weapon: "bow" },
  longbowman: { cat: "ranged", weapon: "bow" },
  rifleman: { cat: "ranged", weapon: "gun", helm: true },
  infantry: { cat: "ranged", weapon: "gun", helm: true },
  catapult: { cat: "siege", weapon: "catapult" },
  ballista: { cat: "siege", weapon: "catapult" },
  trebuchet: { cat: "siege", weapon: "catapult" },
  cannon: { cat: "siege", weapon: "cannon" },
  artillery: { cat: "siege", weapon: "cannon" },
  tank: { cat: "siege", weapon: "cannon" },
  settler: { cat: "civil", weapon: "none" },
  caravan: { cat: "civil", weapon: "none" },
  wagon: { cat: "civil", weapon: "none" },
  train: { cat: "civil", weapon: "none" },
};

/** How a unit is drawn on the battlefield; an unknown fighting unit is a swordsman, an unknown civilian walks unarmed. */
export function figureLook(unitId: string): FigureLook {
  const known = LOOKS[unitId];
  if (known) return known;
  const u = unitById.get(unitId);
  if (u?.breach) return { cat: "siege", weapon: "catapult" };
  if (u?.civilian || u?.hauler) return { cat: "civil", weapon: "none" };
  if (u?.needsResource === "horses") return { cat: "horse", weapon: "spear" };
  return { cat: "foot", weapon: "sword" };
}

/** Ranks run this many files deep. */
export const FIELD_FILES = 6;
/** Above this many units a side, each figure stands for several. */
export const FIELD_MAX_FIGURES = 54;
/** Partial columns fill from the middle files out. */
const FILE_ORDER = [2, 3, 1, 4, 0, 5];
const SIEGE_FILES = [1, 4, 2.5, 0, 5, 3];
const CAT_RANK: Record<FigureCat, number> = { foot: 0, horse: 1, ranged: 2, civil: 3, siege: 4 };

export interface FieldFigure {
  /** Stable index across the whole field. */
  n: number;
  side: 0 | 1;
  unit: string;
  look: FigureLook;
  /** Starting column (0 is the front line) and file (0 farthest from the viewer). Siege engines sit behind the last column. */
  col0: number;
  file: number;
  /** Small fixed jitters so ranks do not look stamped: x in field units, depth as a fraction, a phase for idle motion. */
  jx: number;
  jd: number;
  ph: number;
  /** Falls backward (1) or forward (-1). */
  fb: 1 | -1;
  /** Tie-break among figures equally far forward. */
  key: number;
  /** The round this figure falls in, and how many seconds into that round; null while standing. */
  fallRound: number | null;
  stagger: number;
}

export interface Battlefield {
  /** Units per figure. */
  k: number;
  figures: FieldFigure[];
}

const total = (u: Record<string, number>) => Object.values(u).reduce((a, b) => a + Math.max(0, b), 0);

/** Front to back: shielded and heavier foot first, then horse, archers and guns, civilians, siege at the rear. */
function lineOrder(units: Record<string, number>): string[] {
  return Object.keys(units)
    .filter((id) => (units[id] ?? 0) > 0)
    .sort((a, b) => {
      const la = figureLook(a), lb = figureLook(b);
      return CAT_RANK[la.cat] - CAT_RANK[lb.cat] || (unitById.get(b)?.defense ?? 0) - (unitById.get(a)?.defense ?? 0) || a.localeCompare(b);
    });
}

export function castBattlefield(seed: string, attacker: Record<string, number>, defender: Record<string, number>, log: ReadonlyArray<{ round: number; aLoss: Record<string, number>; dLoss: Record<string, number> }>): Battlefield {
  const rng = seededRng(`field:${seed}`);
  const k = Math.max(1, Math.ceil(Math.max(total(attacker), total(defender)) / FIELD_MAX_FIGURES));
  const figures: FieldFigure[] = [];
  const starts = [attacker, defender] as const;
  starts.forEach((start, side) => {
    const order = lineOrder(start);
    let j = 0;
    const line: FieldFigure[] = [];
    const siege: FieldFigure[] = [];
    for (const unit of order) {
      const look = figureLook(unit);
      const count = Math.ceil((start[unit] ?? 0) / k);
      for (let i = 0; i < count; i++) {
        const f: FieldFigure = { n: figures.length, side: side as 0 | 1, unit, look, col0: 0, file: 0, jx: (rng() - 0.5) * 6, jd: (rng() - 0.5) * 0.05, ph: rng() * Math.PI * 2, fb: rng() < 0.78 ? 1 : -1, key: rng(), fallRound: null, stagger: 0 };
        figures.push(f);
        if (look.cat === "siege") siege.push(f);
        else {
          f.col0 = Math.floor(j / FIELD_FILES);
          f.file = FILE_ORDER[j % FIELD_FILES]!;
          j++;
          line.push(f);
        }
      }
    }
    const maxCol = line.length ? Math.max(...line.map((f) => f.col0)) : 0;
    siege.forEach((f, i) => {
      f.file = SIEGE_FILES[i % SIEGE_FILES.length]!;
      f.col0 = maxCol + 2 + Math.floor(i / SIEGE_FILES.length) * 1.4;
    });
  });

  const alive = starts.map((s) => ({ ...s }));
  for (const entry of [...log].sort((a, b) => a.round - b.round)) {
    [entry.aLoss, entry.dLoss].forEach((losses, side) => {
      for (const unit of lineOrder(losses)) {
        const n = losses[unit] ?? 0;
        const was = alive[side]![unit] ?? 0;
        const now = Math.max(0, was - n);
        alive[side]![unit] = now;
        for (let d = Math.ceil(was / k) - Math.ceil(now / k); d > 0; d--) fell(figures, side as 0 | 1, unit, entry.round, rng);
      }
    });
  }
  return { k, figures };
}

/** The current column of every standing figure: in each file the living close up toward the front, keeping their order. */
export function closeRanks(figures: ReadonlyArray<FieldFigure>, side: 0 | 1, standing: (f: FieldFigure) => boolean): Map<number, number> {
  const out = new Map<number, number>();
  const byFile = new Map<number, FieldFigure[]>();
  for (const f of figures) {
    if (f.side !== side || !standing(f)) continue;
    if (f.look.cat === "siege") {
      out.set(f.n, f.col0);
      continue;
    }
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  for (const list of byFile.values()) list.sort((a, b) => a.col0 - b.col0).forEach((f, i) => out.set(f.n, i));
  return out;
}

function fell(figures: FieldFigure[], side: 0 | 1, unit: string, round: number, rng: () => number) {
  const pool = figures.filter((f) => f.side === side && f.unit === unit && f.fallRound === null);
  if (!pool.length) return;
  let pick: FieldFigure;
  if (pool[0]!.look.cat === "ranged") pick = pool[Math.floor(rng() * pool.length)]!;
  else {
    // The front-most of that unit falls: the one in the lowest column once the ranks have closed.
    const cols = closeRanks(figures, side, (f) => f.fallRound === null);
    pick = pool.reduce((best, f) => ((cols.get(f.n) ?? 0) - (cols.get(best.n) ?? 0) || f.key - best.key) < 0 ? f : best);
  }
  pick.fallRound = round;
  pick.stagger = 0.2 + rng() * 1.6;
}
