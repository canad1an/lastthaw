import { BUILDINGS, buildingById, WALL_ORDER } from "@lastthaw/shared";
import townSlots from "./townSlots.json";

/** A region's precomputed town plan (tools/mapgen/src/town-slots.mjs): centre, slot spacing, bounding box and slots. */
export interface TownSlot {
  c: [number, number];
  r: number;
  b: [number, number, number, number];
  s: [number, number][];
}

export const TOWN_SLOTS: Record<string, TownSlot | undefined> = townSlots as unknown as Record<string, TownSlot>;

/** Zoom from which a region's buildings are drawn on the map. */
export const TOWN_K = 14;
/** Zoom from which each building shows its level. */
export const BADGE_K = 20;
/** A building picture's width in map units; shrunk where a region's slots sit closer than that. */
export const PIC = 2.2;

/** Buildings drawn some other way: walls as the region's ring, the harbour on the quay, roads and rails as links. */
const ELSEWHERE = new Set<string>([...WALL_ORDER, "harbor", "roads", "railway"]);
const CATEGORY_ORDER = ["growth", "production", "storage", "training", "transport", "loyalty", "defense", "wonder"];
const INDEX = new Map(BUILDINGS.map((b, i) => [b.id, i]));

export interface Placed {
  id: string;
  level: number;
  x: number;
  y: number;
}

/**
 * The buildings of a region on its slots: the wonder at the centre, the rest in category order (growth first) on
 * the slots from the outside in. Buildings beyond the slot count are left out; the region panel lists them all.
 */
export function placeBuildings(buildings: Record<string, number>, slot: TownSlot): Placed[] {
  const ids = Object.entries(buildings)
    .filter(([id, level]) => level > 0 && !ELSEWHERE.has(id) && buildingById.has(id))
    .map(([id, level]) => ({ id, level, def: buildingById.get(id)! }))
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.def.category) - CATEGORY_ORDER.indexOf(b.def.category) || (INDEX.get(a.id) ?? 0) - (INDEX.get(b.id) ?? 0));
  const out: Placed[] = [];
  let next = 0;
  for (const { id, level, def } of ids) {
    if (def.category === "wonder") {
      out.push({ id, level, x: slot.c[0], y: slot.c[1] });
      continue;
    }
    const s = slot.s[next++];
    if (!s) break;
    out.push({ id, level, x: s[0], y: s[1] });
  }
  return out;
}

/** How wide each picture is drawn in a region, in map units. */
export function pictureSize(slot: TownSlot): number {
  return Math.min(PIC, slot.r * 0.9);
}
