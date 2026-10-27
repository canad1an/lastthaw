import { useCallback, useState } from "react";
import { balance, iceDaysFor, loyaltyOutlook, regionById, unitById, type MatchStateView } from "@lastthaw/shared";

/** Map overlays the player can switch on from the View menu. Each marks regions with a small badge. */
export interface OverlayDef {
  id: string;
  label: string;
  description: string;
  colour: string;
  glyph: string;
}

export const OVERLAYS: OverlayDef[] = [
  { id: "full", label: "Full stores", description: "Food, wood or stone at 95% of the region's cap: spend it or ship it.", colour: "#facc15", glyph: "$" },
  { id: "soldiers", label: "Idle soldiers", description: "Regions with military units stationed and not on a mission.", colour: "#f97316", glyph: "⚔" },
  { id: "caravans", label: "Idle caravans", description: "Regions with caravans standing at home.", colour: "#38bdf8", glyph: "≡" },
  { id: "queue", label: "Empty build queue", description: "Regions with nothing building or training.", colour: "#a78bfa", glyph: "·" },
  { id: "ice", label: "Ice within 3 days", description: "Regions the ice reaches within three days. Evacuate or accept the loss.", colour: "#e0f2fe", glyph: "❄" },
  { id: "noroads", label: "No roads", description: "Regions that could build Roads but have not.", colour: "#94a3b8", glyph: "⌁" },
  { id: "norail", label: "No railway", description: "Once you know Railways: your regions whose Roads are not yet raised to level 2, the Railway. Trains run at full speed only on track between two Railway regions.", colour: "#a07d55", glyph: "≠" },
  { id: "hidehaulers", label: "Hide haulers", description: "Hides caravans, wagons, freight wagons, trains, lorries and cogs on the move. Soldiers, settlers, enemies and the capital wagon still show.", colour: "#64748b", glyph: "≡" },
  { id: "hideroads", label: "Hide roads", description: "Hides the roads and the railway track drawn between regions.", colour: "#94a3b8", glyph: "⌁" },
  { id: "flat", label: "Flat map", description: "Hides the terrain relief under the regions and paints them in plain colours. Lighter on an old phone.", colour: "#475569", glyph: "▭" },
  { id: "loyalty", label: "Loyalty", description: "Tints your regions by loyalty: green secure, amber uneasy, red at risk of rebellion. Badge on regions heading down.", colour: "#f43f5e", glyph: "!" },
];

export interface OverlayBadge {
  regionId: string;
  colour: string;
  glyph: string;
  label: string;
  /** A pulsing ring, for something happening right now. */
  pulse?: boolean;
  /** Clicking the badge opens this battle. */
  battleId?: string;
}

/** Which overlays are on, remembered on this device. */
export function useOverlays(): { enabled: Set<string>; toggle: (id: string) => void } {
  const [enabled, setEnabled] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("lt_overlays");
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((id: string) => {
    setEnabled((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem("lt_overlays", JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);
  return { enabled, toggle };
}

/**
 * How much of the terrain relief shows through a region's fill. Own and rival colours stay strong enough to read at
 * a glance; neutral land is barely tinted; unseen land is darkened rather than coloured, so the fog still reads.
 */
export const RELIEF_FILL = { own: 0.55, rival: 0.6, enemy: 0.65, target: 0.8, terrain: 0.25, frontier: 0.2, unseen: 0.45, picking: 0.3 } as const;
export const FOG_FILL = "#0b1a2b";

const NOTE_HEX: Record<string, string> = { red: "#f43f5e", amber: "#f59e0b", green: "#22c55e", blue: "#38bdf8", purple: "#a78bfa" };

/** The player's own markers: every region with a coloured note gets a pin, whatever overlays are on. */
export function noteBadges(state: MatchStateView): OverlayBadge[] {
  return state.notes
    .filter((n) => n.colour)
    .map((n) => ({ regionId: n.regionId, colour: NOTE_HEX[n.colour!] ?? "#f8fafc", glyph: "✎", label: `${regionById(n.regionId)?.name ?? n.regionId}${n.text ? `: ${n.text}` : ""}` }));
}

/**
 * The advisors' marks: a red crossed swords on every Military target, an amber shield on the most exposed border
 * regions, and a snowflake on every region the Warden of the Thaw has on the clock.
 */
export function advisorBadges(state: MatchStateView): OverlayBadge[] {
  const out: OverlayBadge[] = [];
  const max = state.advisors.find((a) => a.kind === "military");
  if (max) {
    out.push(...max.settings.targets.map((id, i) => ({ regionId: id, colour: "#f43f5e", glyph: "⚔", label: `Target ${i + 1} for the Military advisor: ${regionById(id)?.name ?? id}` })));
    for (const e of max.lastReport?.exposed ?? []) if (e.exposure >= 1) out.push({ regionId: e.regionId, colour: "#f59e0b", glyph: "⛨", label: e.text });
  }
  const freya = state.advisors.find((a) => a.kind === "thaw");
  for (const l of freya?.lastReport?.clock ?? []) out.push({ regionId: l.regionId, colour: "#7dd3fc", glyph: "❄", label: l.text });
  return out;
}

/** Crossed swords, pulsing, on every region where a battle is playing out; clicking opens the battle window. */
export function battleBadges(state: MatchStateView): OverlayBadge[] {
  return state.battles.map((b) => ({
    regionId: b.regionId,
    colour: "#f43f5e",
    glyph: "⚔",
    label: `${b.attackerName} ${b.mission === "raid" ? "raiding" : "attacking"} ${regionById(b.regionId)?.name ?? b.regionId}: round ${b.round} of ${b.totalRounds}. Click to watch.`,
    pulse: true,
    battleId: b.id,
  }));
}

/** Badges for the enabled overlays, from the current match state. */
export function overlayBadges(state: MatchStateView, enabled: Set<string>, matchDay: number): OverlayBadge[] {
  if (enabled.size === 0) return [];
  const byId = new Map(OVERLAYS.map((o) => [o.id, o]));
  const out: OverlayBadge[] = [];
  const push = (id: string, regionId: string, label: string) => {
    const o = byId.get(id)!;
    out.push({ regionId, colour: o.colour, glyph: o.glyph, label });
  };
  const busy = new Set(state.jobs.filter((j) => j.kind === "build" || j.kind === "train").map((j) => j.regionId));
  for (const r of state.owned) {
    if (r.frozen) continue;
    const name = regionById(r.regionId)?.name ?? r.regionId;
    if (enabled.has("full")) {
      const full = (["food", "wood", "stone"] as const).filter((k) => r[k] >= r.storage[k] * 0.95);
      if (full.length) push("full", r.regionId, `${name}: ${full.join(", ")} at cap`);
    }
    if (enabled.has("soldiers")) {
      const n = Object.entries(r.units).reduce((a, [id, c]) => a + (unitById.get(id)?.civilian ? 0 : c), 0);
      if (n > 0) push("soldiers", r.regionId, `${name}: ${n} soldiers stationed`);
    }
    if (enabled.has("caravans") && (r.units.caravan ?? 0) > 0) push("caravans", r.regionId, `${name}: ${r.units.caravan} caravans idle`);
    if (enabled.has("queue") && !busy.has(r.regionId)) push("queue", r.regionId, `${name}: build queue empty`);
    if (enabled.has("ice")) {
      const region = regionById(r.regionId);
      const { touch } = region ? iceDaysFor(region) : { touch: null };
      if (touch !== null && touch - matchDay <= 3) push("ice", r.regionId, `${name}: ice in ${Math.max(0, touch - matchDay).toFixed(1)} days`);
    }
    if (enabled.has("noroads") && state.me.techs.includes("road_building") && (r.buildings.roads ?? 0) < 1) push("noroads", r.regionId, `${name}: no roads`);
    if (enabled.has("norail") && state.me.techs.includes("railways") && (r.buildings.roads ?? 0) < 2) push("norail", r.regionId, `${name}: no railway${(r.buildings.roads ?? 0) < 1 ? " (no roads yet)" : ""}`);
    if (enabled.has("loyalty") && !r.isCapital) {
      const o = loyaltyOutlook(r.regionId, state.me.capitalRegionId, r.effects.loyalty, r.popWorkers + r.popSoldiers + r.popOccupiers, r.popOccupiers, r.loyalty, r.conquered);
      if (o.target < r.loyalty - 0.02 || r.loyalty < o.rebelBelow) push("loyalty", r.regionId, `${name}: loyalty ${Math.round(r.loyalty * 100)}% heading to ${Math.round(o.target * 100)}%${r.loyalty < o.rebelBelow ? ", may rebel" : ""}`);
    }
  }
  return out;
}

export const OVERLAY_HINT = `Badges sit at the region centre; hover one for details. Full stores use ${Math.round(balance.trade.overflowShare * 100)}% overflow to the capital when caravans are free.`;
