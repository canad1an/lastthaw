import { unitById } from "@lastthaw/shared";
import { UNIT_PICTURES } from "./unitPictures.js";

/**
 * One pictogram per unit, drawn as strokes and a few filled shapes in a 24 x 24 box, in the current text colour.
 * The same drawings go on the map markers (dark on the marker's disc) and beside every unit name in the panels,
 * so a canoe looks like a canoe wherever it is, a settler like someone with a bindle, an archer like a bow.
 */
interface Stroke {
  d: string;
  /** Filled rather than outlined. */
  f?: boolean;
  /** Stroke width override (default 1.7). */
  w?: number;
}

const HEAD = "M12 2.6a1.9 1.9 0 1 0 0.01 0";
/** A standing figure: head, torso and two legs. Weapons and gear are added per unit. */
const PERSON: Stroke[] = [{ d: HEAD, f: true }, { d: "M12 6.5v7.5" }, { d: "M12 14l-3.2 7" }, { d: "M12 14l3.2 7" }];
/** A horse seen from the side, legs under, head up to the right; the rider's head sits above the back. */
const HORSE: Stroke[] = [
  { d: "M4.5 14c0-2.8 2.5-4.5 6-4.5h4.5c1.6 0 2.5 1 2.5 2.5V14z", f: true },
  { d: "M15.5 10l2.5-4.5h2.5l1.5 2.2-2 1.3-1.2 2.5", f: true },
  { d: "M6.5 14v7" },
  { d: "M10 14v7" },
  { d: "M14 14v7" },
  { d: "M17 14v7" },
  { d: "M4.5 12.5l-2.5 3.5" },
  { d: "M11 3.4a1.8 1.8 0 1 0 0.01 0", f: true },
  { d: "M11 7v3" },
];

const GLYPHS: Record<string, Stroke[]> = {
  // Levies and foot soldiers.
  warrior: [...PERSON, { d: "M15 11.5l4.5-6" }, { d: "M19.8 4.6a1.6 1.6 0 1 0 0.01 0", f: true }],
  militia: [...PERSON, { d: "M17 21V7" }, { d: "M14.5 7h5" }, { d: "M14.5 7V4.2" }, { d: "M17 7V4.2" }, { d: "M19.5 7V4.2" }],
  sellsword: [...PERSON, { d: "M15 13.5l5.5-7" }, { d: "M17.6 9.3l2.4 1.8" }, { d: "M5.5 13.5a2.2 2.6 0 1 0 0.01 0", f: true }],
  free_company: [...PERSON, { d: "M17.5 21V3" }, { d: "M17.5 4.5l4 2-4 2.2z", f: true }, { d: "M17.5 3l-2.5 1.5" }],
  slinger: [...PERSON, { d: "M8.5 9.5c-3.5 0.5-4.5 4-2 6" }, { d: "M6.2 16a1.4 1.4 0 1 0 0.01 0", f: true }],
  tracker: [...PERSON, { d: "M7 21V6" }, { d: "M15 9.5l5-2.8" }, { d: "M19.6 6.9l1.6-0.9", w: 2.6 }],
  spearman: [...PERSON, { d: "M17.5 21V3.5" }, { d: "M17.5 3l-1.6 3.4h3.2z", f: true }],
  archer: [...PERSON, { d: "M17.5 3.5c4.5 4.5 4.5 12.5 0 17" }, { d: "M17.5 3.5v17", w: 1 }, { d: "M8.5 12h9" }, { d: "M15.5 10l2 2-2 2" }],
  longbowman: [...PERSON, { d: "M18.5 1.8c5.5 5.5 5.5 14.9 0 20.4" }, { d: "M18.5 1.8v20.4", w: 1 }, { d: "M7 12h11.5" }, { d: "M16.5 10l2 2-2 2" }],
  swordsman: [...PERSON, { d: "M17.5 20V5" }, { d: "M14.8 8h5.4" }, { d: "M6.5 9.5a2.8 2.8 0 1 0 0.01 0", f: true }],
  legionary: [...PERSON, { d: "M3.5 7h6v9l-3 2.5-3-2.5z", f: true }, { d: "M16 13l4-6" }, { d: "M9.5 2.5c1.5-1 3.5-1 5 0", w: 2.2 }],
  rifleman: [...PERSON, { d: "M6 19.5L18.5 7" }, { d: "M18.5 7l2-2", w: 2.6 }, { d: "M8.5 4.5h7", w: 1.4 }],
  infantry: [...PERSON, { d: "M9.3 4.4a2.7 2.7 0 0 1 5.4 0", w: 2.2 }, { d: "M17 21V9" }, { d: "M17 9l1.2-2.5" }, { d: "M7 10.5v3" }],
  // Mounted.
  chariot: [{ d: "M2.5 10h8v4h-8z", f: true }, { d: "M6.5 17.5a3 3 0 1 0 0.01 0" }, { d: "M6.5 2.6a1.8 1.8 0 1 0 0.01 0", f: true }, { d: "M6.5 6.2V10" }, { d: "M8 8l7.5 3" }, { d: "M14.5 12.5l2.5-4.5h2.5l1.5 2.2-2 1.3-1.2 2.5", f: true }, { d: "M16.5 14v7" }, { d: "M20 14v7" }, { d: "M10.5 12h4" }],
  cavalry: [...HORSE, { d: "M12 11l4.5-5" }, { d: "M14.5 7.4l1.9 1.6" }],
  knight: [...HORSE, { d: "M7.5 13.5l9.5-10" }, { d: "M5 13h10v2.5H5z", f: true }],
  cataphract: [...HORSE, { d: "M7 13.5l10.5-11" }, { d: "M4 12.5h11.5v3.5H4z", f: true }, { d: "M9.3 4.8a2.2 2.2 0 0 1 2.4-2.1" }],
  // Engines and guns.
  catapult: [{ d: "M4 20.5h16" }, { d: "M5 20.5l4-7h5l4 7" }, { d: "M8.5 18.5L18.5 6" }, { d: "M19.2 5.2a2 2 0 1 0 0.01 0", f: true }, { d: "M6.5 20.5a1.8 1.8 0 1 0 0.01 0" }, { d: "M16.5 20.5a1.8 1.8 0 1 0 0.01 0" }],
  ballista: [{ d: "M12 21V10" }, { d: "M8 21h8" }, { d: "M3.5 9.5c4.5-4.5 12.5-4.5 17 0" }, { d: "M3.5 9.5h17", w: 1 }, { d: "M12 15V3" }, { d: "M12 3l-1.8 3h3.6z", f: true }],
  trebuchet: [{ d: "M5.5 21l6.5-12 6.5 12" }, { d: "M3 21h18" }, { d: "M12 9l9-6.5" }, { d: "M12 9l-6 2.5" }, { d: "M5 12.5a2.3 2.3 0 1 0 0.01 0", f: true }, { d: "M20.5 3.5l1.5 2" }],
  cannon: [{ d: "M3.5 10.5h12l5-3.5v4.5l-5 3.5h-12z", f: true }, { d: "M9.5 18.5a3 3 0 1 0 0.01 0" }, { d: "M9.5 15.5l-5 4" }],
  artillery: [{ d: "M3 16.5L20 7", w: 2.4 }, { d: "M19 6l2-1.2", w: 3 }, { d: "M3 16.5h8" }, { d: "M8 18.5a3 3 0 1 0 0.01 0" }, { d: "M7 11.5l3.5 3.5", w: 2.4 }],
  tank: [{ d: "M3 13h18l-2.5 5.5H5.5z", f: true }, { d: "M8 13v-3.5h8V13", f: true }, { d: "M16 11h6" }, { d: "M4.5 18.5h15", w: 1 }],
  // Civil folk and haulers.
  settler: [...PERSON, { d: "M15 10.5l5-5.5" }, { d: "M18.5 3.5l3 3-1.6 1.6-3-3z", f: true }, { d: "M8.2 4.5h7.6", w: 1.4 }],
  caravan: [{ d: "M5 16.5h10.5c0-4.5-2.2-7.5-5.3-7.5s-5.2 3-5.2 7.5z", f: true }, { d: "M15.5 12.5l2.5-3.5 2.5 1.5" }, { d: "M7 16.5v5" }, { d: "M13 16.5v5" }, { d: "M18 10.5v3" }],
  wagon: [{ d: "M4 10.5h12v7H4z", f: true }, { d: "M4 10.5c2-4.5 10-4.5 12 0" }, { d: "M7 19a2.3 2.3 0 1 0 0.01 0" }, { d: "M13 19a2.3 2.3 0 1 0 0.01 0" }, { d: "M16 14.5h5.5" }],
  freight_wagon: [{ d: "M3 11h15v6.5H3z", f: true }, { d: "M3 11l2-3h11l2 3" }, { d: "M6 19.5a2 2 0 1 0 0.01 0" }, { d: "M11 19.5a2 2 0 1 0 0.01 0" }, { d: "M16 19.5a2 2 0 1 0 0.01 0" }, { d: "M18 14.5h4" }],
  train: [{ d: "M3 12h12v6.5H3z", f: true }, { d: "M15 9h5.5v9.5H15z", f: true }, { d: "M6 12V6.5h3.5V12", f: true }, { d: "M5.5 20.5a1.8 1.8 0 1 0 0.01 0" }, { d: "M11 20.5a1.8 1.8 0 1 0 0.01 0" }, { d: "M17.5 20.5a1.8 1.8 0 1 0 0.01 0" }, { d: "M8 4.5c1.5-1 3-1 4.5 0", w: 1.2 }],
  lorry: [{ d: "M2.5 8h12.5v10H2.5z", f: true }, { d: "M15 10.5h4.5l2.5 3.5v4H15z", f: true }, { d: "M6 20a2.3 2.3 0 1 0 0.01 0" }, { d: "M17.5 20a2.3 2.3 0 1 0 0.01 0" }],
  // Boats.
  canoe: [{ d: "M2.5 13.5c3 4.5 16 4.5 19 0", w: 2 }, { d: "M2.5 13.5c3-1.3 16-1.3 19 0" }, { d: "M11 5.5l4 9.5" }, { d: "M9.6 5.9l2.8-1.2", w: 2.6 }],
  galley: [{ d: "M3 13.5h18l-3 5.5H6z", f: true }, { d: "M6.5 13.5l-2 4" }, { d: "M10.5 13.5l-2 4" }, { d: "M14.5 13.5l-2 4" }, { d: "M18.5 13.5l-2 4" }, { d: "M12 13.5V3.5" }, { d: "M12 4.5l5.5 6.5H12z", f: true }],
  cog: [{ d: "M4 13h16l-2.5 6.5h-11z", f: true }, { d: "M12 13V3" }, { d: "M7.5 4.5h9v6.5h-9z", f: true }],
  ironclad: [{ d: "M2.5 14.5h19l-2.5 5h-14z", f: true }, { d: "M8 14.5v-4.5h8v4.5", f: true }, { d: "M11 10V5.5h2.5V10", f: true }, { d: "M12.5 4.5c1.5-1 2.5-1.5 3.5-2.5", w: 1.3 }, { d: "M16 12h4" }],
  destroyer: [{ d: "M2 15h20l-3 4.5H5z", f: true }, { d: "M9 15v-4.5h7V15", f: true }, { d: "M11.5 10.5V4.5" }, { d: "M4 13h3.5" }, { d: "M18 13h2.5" }],
  // Aircraft.
  scout_plane: [{ d: "M4 12.5h16", w: 2.2 }, { d: "M11 12.5l-3-6.5h4.5l1.5 6.5", f: true }, { d: "M11 12.5l-3 6.5h4.5l1.5-6.5", f: true }, { d: "M4 12.5L3 9.5h3" }],
  transport_plane: [{ d: "M3 12.5h18", w: 2.8 }, { d: "M9 12.5L7 4h5l2.5 8.5", f: true }, { d: "M9 12.5L7 21h5l2.5-8.5", f: true }, { d: "M3 12.5L2.5 9h3.5" }, { d: "M3 12.5L2.5 16h3.5" }],
  bomber: [{ d: "M3 12h18", w: 2.4 }, { d: "M10 12L6 3h6l2 9", f: true }, { d: "M10 12l-4 9h6l2-9", f: true }, { d: "M15.5 12a1.6 1.6 0 1 0 0.01 0", f: true }],
};

/** A unit the table does not know: something by its kind, so nothing is ever blank. */
function fallback(id: string): Stroke[] {
  const u = unitById.get(id);
  if (u?.air) return GLYPHS.scout_plane!;
  if (u?.naval) return GLYPHS.galley!;
  if (u?.hauler) return GLYPHS.wagon!;
  if (u?.civilian) return GLYPHS.settler!;
  return GLYPHS.warrior!;
}

export function unitGlyph(id: string): Stroke[] {
  return GLYPHS[id] ?? fallback(id);
}

/** The strokes of a unit's pictogram as SVG children, for use inside any `<svg>` or `<g>` sized to the 24-box. */
export function UnitStrokes({ id, color = "currentColor" }: { id: string; color?: string }) {
  return (
    <g fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {unitGlyph(id).map((s, i) => (
        <path key={i} d={s.d} fill={s.f ? color : "none"} strokeWidth={s.w ?? (s.f ? 1 : 1.7)} />
      ))}
    </g>
  );
}

/** The illustrated picture of a unit, when one exists under /units. */
export function unitPicture(id: string): string | null {
  return UNIT_PICTURES.has(id) ? `/units/${id}.png` : null;
}

/** An inline icon beside a unit's name: the illustrated picture where one exists, else the line drawing in the text colour. */
export function UnitIcon({ id, className = "h-5 w-5", title }: { id: string; className?: string; title?: string }) {
  const pic = unitPicture(id);
  if (pic) return <img src={pic} alt={title ?? ""} title={title} className={`inline-block shrink-0 object-contain ${className}`} loading="lazy" draggable={false} />;
  return (
    <svg viewBox="0 0 24 24" className={`inline-block shrink-0 ${className}`} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <UnitStrokes id={id} />
    </svg>
  );
}
