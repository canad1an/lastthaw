import { balance } from "../config/balance.js";
import { distanceKm, regionById } from "../map/index.js";
import { scaledDuration } from "./time.js";

export interface Route {
  /** Region ids from origin to target inclusive. */
  path: string[];
  /** Effective distance in km after terrain and water modifiers. */
  cost: number;
  usesSea: boolean;
}

function edgeCost(from: string, to: string, sea: boolean, roads?: ReadonlySet<string>, rails?: ReadonlySet<string>, harbors?: ReadonlySet<string>): number {
  const a = regionById(from)!;
  const b = regionById(to)!;
  const t = balance.travel;
  let c = distanceKm(a, b);
  if (sea) {
    const n = harbors ? (harbors.has(from) ? 1 : 0) + (harbors.has(to) ? 1 : 0) : 0;
    return c * t.seaFactor * (n === 2 ? t.harborBothFactor : n === 1 ? t.harborOneFactor : 1);
  }
  c *= t.terrain[b.terrain] ?? 1;
  if (b.river || b.coastal) c *= t.waterwayFactor;
  if (rails && rails.has(from) && rails.has(to)) return c * t.railBothFactor;
  if (roads) {
    const n = (roads.has(from) ? 1 : 0) + (roads.has(to) ? 1 : 0);
    if (n === 2) c *= t.roadBothFactor;
    else if (n === 1) c *= t.roadOneFactor;
  }
  return c;
}

/**
 * Shortest route over land borders and, if allowed, sea routes. Dijkstra over
 * ~400 nodes; cheap enough to run per request.
 */
export function findRoute(origin: string, target: string, allowSea: boolean, roads?: ReadonlySet<string>, rails?: ReadonlySet<string>, harbors?: ReadonlySet<string>): Route | null {
  if (origin === target) return { path: [origin], cost: 0, usesSea: false };
  const dist = new Map<string, number>([[origin, 0]]);
  const prev = new Map<string, { from: string; sea: boolean }>();
  const open = new Set<string>([origin]);
  const closed = new Set<string>();

  while (open.size) {
    let cur: string | null = null;
    let best = Infinity;
    for (const id of open) {
      const d = dist.get(id)!;
      if (d < best) {
        best = d;
        cur = id;
      }
    }
    if (!cur) break;
    open.delete(cur);
    closed.add(cur);
    if (cur === target) break;
    const r = regionById(cur)!;
    const edges: Array<[string, boolean]> = r.neighbors.map((n) => [n, false] as [string, boolean]);
    if (allowSea) for (const n of r.seaRoutes) edges.push([n, true]);
    for (const [n, sea] of edges) {
      if (closed.has(n)) continue;
      const nd = best + edgeCost(cur, n, sea, roads, rails, harbors);
      if (nd < (dist.get(n) ?? Infinity)) {
        dist.set(n, nd);
        prev.set(n, { from: cur, sea });
        open.add(n);
      }
    }
  }
  if (!dist.has(target)) return null;
  const path: string[] = [target];
  let usesSea = false;
  let at = target;
  while (at !== origin) {
    const p = prev.get(at)!;
    if (p.sea) usesSea = true;
    at = p.from;
    path.push(at);
  }
  path.reverse();
  return { path, cost: dist.get(target)!, usesSea };
}

/** Real seconds for an army of `speedKmPerHour` to cover a route at match speed. */
export function travelSeconds(route: Route, speedKmPerHour: number, matchSpeed: number): number {
  const t = balance.travel;
  const hours = route.cost / Math.max(0.1, speedKmPerHour * t.speedScale);
  return scaledDuration(Math.max(t.minSeconds, hours * 3600), matchSpeed);
}

/** Human name for a mission as a moving group: Settlers, Caravans, Capital wagon, Raid... */
export function missionLabel(mission: string, units?: Record<string, number>): string {
  switch (mission) {
    case "settle":
      return "Settlers";
    case "transport": {
      if (units?.train) return "Trains";
      if (units?.wagon) return "Wagons";
      return "Caravans";
    }
    case "relocate":
      return "Capital wagon";
    case "move":
      return "Move";
    case "reinforce":
      return "Reinforcements";
    case "scout":
      return "Scouts";
    case "patrol":
      return "Patrol";
    case "expedition":
      return "Expedition";
    default:
      return mission.charAt(0).toUpperCase() + mission.slice(1);
  }
}

/** Canonical key for the sea lane between two coastal regions. */
export function laneKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The sea lanes a path crosses: consecutive regions joined by a sea route, not a land border. */
export function seaLegsOf(path: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = regionById(path[i - 1]!);
    const b = path[i]!;
    if (a && !a.neighbors.includes(b) && a.seaRoutes.includes(b)) out.push(laneKey(a.id, b));
  }
  return out;
}

/** Label for a mission as a moving group, continued: patrols. */
export function laneName(lane: string): string {
  const [a, b] = lane.split("|");
  return `${regionById(a ?? "")?.name ?? a} – ${regionById(b ?? "")?.name ?? b}`;
}
