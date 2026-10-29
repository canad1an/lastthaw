import { balance } from "../config/balance.js";
import { unitById } from "../config/ages.js";
import { distanceKm, regionById } from "../map/index.js";
import { scaledDuration } from "./time.js";

export interface Route {
  /** Region ids from origin to target inclusive. */
  path: string[];
  /** Effective distance in km after terrain and water modifiers. */
  cost: number;
  usesSea: boolean;
  /** With a risk given to findRoute: the cost the route was chosen by, the risk included. */
  weight?: number;
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
 * ~400 nodes; cheap enough to run per request. With `risk`, each region a land leg enters weighs that many km more
 * when choosing the way (unfriendly ground); the route's cost is still the real distance, its weight the risky one.
 * With `pace` (a train convoy, see paceFor), each land leg's cost is multiplied by how much slower the convoy goes
 * on it (1 on track, more off it) and track legs take the road factor rather than the rail cut, since the train's own
 * speed is the track's benefit: the cost is then time at the convoy's top speed, so the quickest way wins even when
 * it is longer.
 */
export function findRoute(origin: string, target: string, allowSea: boolean, roads?: ReadonlySet<string>, rails?: ReadonlySet<string>, harbors?: ReadonlySet<string>, risk?: (regionId: string) => number, pace?: (onTrack: boolean) => number): Route | null {
  if (origin === target) return { path: [origin], cost: 0, usesSea: false, weight: 0 };
  const dist = new Map<string, number>([[origin, 0]]);
  const real = new Map<string, number>([[origin, 0]]);
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
      const onTrack = !sea && !!rails && rails.has(cur) && rails.has(n);
      const step = pace && !sea ? edgeCost(cur, n, sea, roads, undefined, harbors) * pace(onTrack) : edgeCost(cur, n, sea, roads, rails, harbors);
      const nd = best + step + (risk && !sea ? risk(n) : 0);
      if (nd < (dist.get(n) ?? Infinity)) {
        dist.set(n, nd);
        real.set(n, real.get(cur)! + step);
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
  return { path, cost: real.get(target)!, usesSea, weight: dist.get(target)! };
}

/** True when every unit in the group flies: aircraft go straight, alone, and only between airfields' reach. */
export function isAirGroup(units: Record<string, number>): boolean {
  const ids = Object.entries(units).filter(([, n]) => n > 0).map(([id]) => id);
  return ids.length > 0 && ids.every((id) => unitById.get(id)?.air);
}

/** How far a flight may go, in km: the shortest range among the aircraft in the group. */
export function airRangeKm(units: Record<string, number>): number {
  let r = Infinity;
  for (const [id, n] of Object.entries(units)) if (n > 0 && unitById.get(id)?.air) r = Math.min(r, unitById.get(id)!.rangeKm ?? 0);
  return r === Infinity ? 0 : r;
}

/** A flight: one straight leg at great-circle distance, no terrain, water, roads or lanes. */
export function airRoute(from: string, to: string): Route {
  return { path: [from, to], cost: distanceKm(from, to), usesSea: false };
}

/** The longest sea lane a group may cross, in km, when it holds a short-lane boat; null when nothing limits it. */
export function laneLimitKm(units: Record<string, number>): number | null {
  for (const [id, n] of Object.entries(units)) if (n > 0 && unitById.get(id)?.shortLanes) return balance.travel.canoeMaxLaneKm;
  return null;
}

/** True when every unit in the group is a land hauler: a convoy, which waystations serve; a single soldier along makes it an army. */
/**
 * How a convoy's pace changes with the track: for a convoy with a unit that runs at full speed only on track (the
 * Train), the factor each land leg's cost is multiplied by, 1 on track (between two road regions, once Railways is known) and its top speed
 * over its off-track speed elsewhere. Undefined for every other group, which goes at one speed everywhere.
 */
export function paceFor(units: Record<string, number>): ((onTrack: boolean) => number) | undefined {
  const moving = Object.entries(units).filter(([, n]) => n > 0).map(([id]) => unitById.get(id)).filter((u): u is NonNullable<typeof u> => !!u);
  if (!moving.length || !moving.some((u) => u.offRailSpeed !== undefined) || !isHaulerConvoy(units)) return undefined;
  const top = Math.min(...moving.map((u) => u.speed));
  const off = Math.min(...moving.map((u) => u.offRailSpeed ?? u.speed));
  return (onTrack) => (onTrack ? 1 : top / Math.max(0.1, off));
}

/** Whether one region reaches another overland through only the player's or allies' land (`friendly`) on the way. */
export function friendlyWalk(from: string, to: string, friendly: (regionId: string) => boolean): boolean {
  if (from === to) return true;
  const way = findRoute(from, to, false);
  return !!way && way.path.slice(1, -1).every((id) => friendly(id));
}

/** Whether every leg of `path` runs on track: each step between two regions in `rails` (roads, with Railways known). */
export function onTrack(path: readonly string[], rails: ReadonlySet<string>): boolean {
  if (path.length < 2) return false;
  for (let i = 1; i < path.length; i++) if (!rails.has(path[i - 1]!) || !rails.has(path[i]!)) return false;
  return true;
}

export function isHaulerConvoy(units: Record<string, number>): boolean {
  const ids = Object.entries(units).filter(([, n]) => n > 0).map(([id]) => id);
  return ids.length > 0 && ids.every((id) => unitById.get(id)?.hauler && !unitById.get(id)?.naval);
}

/**
 * What a convoy's waystations are worth on a path: each region entered cuts the leg ending there by its haul share
 * (capped), and the cuts multiply along the way. The origin is not entered and counts for nothing.
 */
export function haulFactor(path: readonly string[], haulOf: ReadonlyMap<string, number>, maxCut = balance.travel.waystationMaxCut): number {
  let f = 1;
  for (let i = 1; i < path.length; i++) f *= 1 - Math.min(maxCut, Math.max(0, haulOf.get(path[i]!) ?? 0));
  return f;
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
    case "airstrike":
      return "Airstrike";
    case "transport": {
      if (units?.transport_plane) return "Transport planes";
      if (units?.lorry) return "Lorries";
      if (units?.train) return "Trains";
      if (units?.freight_wagon) return "Freight wagons";
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
      return units?.scout_plane ? "Scout planes" : "Scouts";
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

/**
 * A voyage: the shortest way by sea alone from one coast to another, lane to lane along the coasts, using only lanes
 * no longer than `maxLaneKm` (a canoe's limit; Infinity for a cog). Each lane costs its length at the sea factor,
 * cheaper with a harbour at one or both of its ends. Null when no such chain of lanes exists.
 */
export function seaPath(from: string, to: string, maxLaneKm: number, harbors?: ReadonlySet<string>): Route | null {
  if (from === to) return null;
  const t = balance.travel;
  const laneCost = (a: string, b: string, km: number) => {
    const n = (harbors?.has(a) ? 1 : 0) + (harbors?.has(b) ? 1 : 0);
    return km * t.seaFactor * (n === 2 ? t.harborBothFactor : n === 1 ? t.harborOneFactor : 1);
  };
  // A state is a region and the stretch of its coast the ship arrived at: a region with two coasts the sea does not join
  // along its shore (Egypt, Panama) is entered on one and left from the same, never carried across. The origin may leave
  // from any of its coasts.
  const stateKey = (id: string, body: number) => `${id}#${body}`;
  const dist = new Map<string, number>([[stateKey(from, -1), 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  let end: string | null = null;
  while (true) {
    let cur: string | null = null;
    let best = Infinity;
    for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; cur = k; }
    if (cur === null) return null;
    const hash = cur.lastIndexOf("#");
    const id = cur.slice(0, hash);
    const arrived = Number(cur.slice(hash + 1));
    if (id === to) { end = cur; break; }
    done.add(cur);
    const r = regionById(id);
    if (!r) continue;
    for (const n of r.seaRoutes) {
      // Leaving on this lane is allowed only from the stretch of coast the ship arrived at; it arrives at the far
      // region on whichever stretch that lane touches there.
      const leaving = r.laneCoasts?.[n] ?? -1;
      if (arrived !== -1 && leaving !== -1 && leaving !== arrived) continue;
      const km = distanceKm(id, n);
      if (km > maxLaneKm) continue;
      const next = stateKey(n, regionById(n)?.laneCoasts?.[id] ?? -1);
      const d = best + laneCost(id, n, km);
      if (d < (dist.get(next) ?? Infinity)) { dist.set(next, d); prev.set(next, cur); }
    }
  }
  const path: string[] = [];
  for (let k: string | undefined = end; k; k = prev.get(k)) path.unshift(k.slice(0, k.lastIndexOf("#")));
  return { path, cost: dist.get(end)!, usesSea: true };
}

/**
 * The next place goods bound for `to` go from `from`, with no hauler ever crossing water. By land all the way: the
 * destination itself. Otherwise the way may hold exactly one sea lane: a land hauler carries the goods to the near
 * harbour, a ship takes them across, a land hauler carries them on. The hop is the first of those that is not here;
 * `relay` says the goods are handed over there rather than delivered. Null when no such way exists (two crossings).
 * With `landable` (the player's own or an ally's regions) the way is chosen by risk as well as distance: every region
 * a land leg enters that is not landable weighs balance.travel.unfriendlyRiskKm more, so goods for a far holding take
 * ship from a harbour of the player's rather than march through strangers' land, even where a land route exists. A
 * voyage that would land at a harbour it does not allow sails on to the destination itself if it has a coast.
 * The sea is preferred over a land route only when `preferSea` says the player has cargo ships to carry the goods; a
 * player without any keeps to land wherever land goes. `bySea` says the leg from here to the hop is sailed.
 */
export function nextHopTo(from: string, to: string, landable?: (regionId: string) => boolean, preferSea = false): { hop: string; relay: boolean; bySea: boolean } | null {
  if (from === to) return null;
  const risk = landable ? (id: string) => (id === to || landable(id) ? 0 : balance.travel.unfriendlyRiskKm) : undefined;
  const land = findRoute(from, to, false, undefined, undefined, undefined, risk);
  const byLand = land ? { hop: to, relay: false, bySea: false } : null;
  if (byLand && (!landable || !preferSea)) return byLand;
  const way = oneCrossing(from, to, landable ?? (() => true), risk);
  if (!way || way.seaStart < 0) return byLand;
  if (land && (land.weight ?? land.cost) <= way.weight) return byLand;
  // At the near harbour already: the voyage's far end is the hop. Else the near harbour is.
  const hop = way.seaStart === 0 ? way.path[way.seaEnd]! : way.path[way.seaStart]!;
  return { hop, relay: hop !== to, bySea: way.seaStart === 0 };
}

/**
 * The best way from one region to another with at most one sea crossing: overland to a harbour (here, or one the
 * player may hand goods over at), one voyage lane to lane, then overland on from where it lands (a harbour the
 * player may unload at, or the destination itself). Dijkstra over (region, stage) with stage 0 before the voyage,
 * 1 at sea and 2 after landing, so the cheapest such way is found even where a cheaper way would need two crossings
 * (Tunisia to India: over the Mediterranean, then again from the Red Sea). Land legs weigh their risk too. Returns the
 * path, where the voyage starts (-1 for none) and ends, and the weight; null when there is no such way.
 */
function oneCrossing(from: string, to: string, landable: (regionId: string) => boolean, risk?: (regionId: string) => number): { path: string[]; seaStart: number; seaEnd: number; weight: number } | null {
  // At sea a state also knows the stretch of coast the ship arrived on: a region with two coasts the sea does not join
  // (Egypt's Mediterranean and Red Sea shores) is never sailed through from one to the other, as in seaPath.
  const key = (id: string, stage: number, coast = -1) => `${id}|${stage}|${coast}`;
  const dist = new Map<string, number>([[key(from, 0), 0]]);
  const prev = new Map<string, string>();
  const open = new Set<string>([key(from, 0)]);
  const done = new Set<string>();
  let end: string | null = null;
  while (open.size) {
    let cur: string | null = null;
    let best = Infinity;
    for (const k of open) {
      const d = dist.get(k)!;
      if (d < best) { best = d; cur = k; }
    }
    if (!cur) break;
    open.delete(cur);
    done.add(cur);
    const [id, stageText, coastText] = cur.split("|") as [string, string, string];
    const stage = Number(stageText);
    const arrived = Number(coastText);
    if (id === to) { end = cur; break; }
    const r = regionById(id);
    if (!r) continue;
    const step = (n: string, nextStage: number, cost: number, coast = -1) => {
      const k = key(n, nextStage, coast);
      if (done.has(k)) return;
      const nd = best + cost;
      if (nd < (dist.get(k) ?? Infinity)) { dist.set(k, nd); prev.set(k, cur!); open.add(k); }
    };
    // Overland: before the voyage, or on from a landing where the goods may be handed over.
    if (stage !== 1 || landable(id)) for (const n of r.neighbors) step(n, stage === 0 ? 0 : 2, edgeCost(id, n, false) + (risk ? risk(n) : 0));
    // By sea: setting out from here or a harbour where the goods may be handed over, or sailing on.
    if (stage === 1 || (stage === 0 && (id === from || landable(id))))
      for (const n of r.seaRoutes) {
        const leaving = r.laneCoasts?.[n] ?? -1;
        if (stage === 1 && arrived !== -1 && leaving !== -1 && leaving !== arrived) continue;
        step(n, 1, edgeCost(id, n, true), regionById(n)?.laneCoasts?.[id] ?? -1);
      }
  }
  if (!end) return null;
  const keys: string[] = [];
  for (let k: string | undefined = end; k; k = prev.get(k)) keys.unshift(k);
  const path = keys.map((k) => k.split("|")[0]!);
  const stages = keys.map((k) => Number(k.split("|")[1]));
  const firstSea = stages.indexOf(1);
  return { path, seaStart: firstSea < 0 ? -1 : firstSea - 1, seaEnd: firstSea < 0 ? -1 : stages.lastIndexOf(1), weight: dist.get(end)! };
}

/** Label for a mission as a moving group, continued: patrols. */
export function laneName(lane: string): string {
  const [a, b] = lane.split("|");
  return `${regionById(a ?? "")?.name ?? a} – ${regionById(b ?? "")?.name ?? b}`;
}

/**
 * Which leg of its path an army is on at `nowMs`, 0 for the first: legs are taken as equal in time, which is
 * close enough to tell "still far off" from "at the border".
 */
export function legIndex(pathLength: number, departsMs: number, arrivesMs: number, nowMs: number): number {
  const legs = Math.max(1, pathLength - 1);
  const span = Math.max(1, arrivesMs - departsMs);
  const progress = Math.min(1, Math.max(0, (nowMs - departsMs) / span));
  return Math.min(legs - 1, Math.floor(progress * legs));
}
