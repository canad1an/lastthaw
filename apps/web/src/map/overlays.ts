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
  { id: "hidehaulers", label: "Hide haulers", description: "Hides caravans, wagons, trains and cogs on the move. Soldiers, settlers, enemies and the capital wagon still show.", colour: "#64748b", glyph: "≡" },
  { id: "loyalty", label: "Loyalty", description: "Tints your regions by loyalty: green secure, amber uneasy, red at risk of rebellion. Badge on regions heading down.", colour: "#f43f5e", glyph: "!" },
];

export interface OverlayBadge {
  regionId: string;
  colour: string;
  glyph: string;
  label: string;
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
    if (enabled.has("loyalty") && !r.isCapital) {
      const o = loyaltyOutlook(r.regionId, state.me.capitalRegionId, r.effects.loyalty, r.popWorkers + r.popSoldiers + r.popOccupiers, r.popOccupiers, r.loyalty, r.conquered);
      if (o.target < r.loyalty - 0.02 || r.loyalty < o.rebelBelow) push("loyalty", r.regionId, `${name}: loyalty ${Math.round(r.loyalty * 100)}% heading to ${Math.round(o.target * 100)}%${r.loyalty < o.rebelBelow ? ", may rebel" : ""}`);
    }
  }
  return out;
}

export const OVERLAY_HINT = `Badges sit at the region centre; hover one for details. Full stores use ${Math.round(balance.trade.overflowShare * 100)}% overflow to the capital when caravans are free.`;
