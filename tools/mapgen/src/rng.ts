/** Deterministic string hash (xmur3) -> 32-bit seed. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 PRNG. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Pick an index according to weights (all weights >= 0, sum > 0). */
  weightedIndex(weights: readonly number[]): number;
}

/** A PRNG seeded from a global seed plus a per-item key, so results are
 * independent of iteration order. */
export function rngFor(seed: string, key: string): Rng {
  const next = mulberry32(xmur3(`${seed}::${key}`)());
  return {
    next,
    weightedIndex(weights) {
      let total = 0;
      for (const w of weights) total += w;
      if (total <= 0) throw new Error("weightedIndex: no positive weights");
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]!;
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
  };
}
