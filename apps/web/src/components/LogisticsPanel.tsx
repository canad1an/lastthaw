import { useMemo } from "react";
import { HAULER_IDS, haulerCarry, regionById, unitById, type MatchStateView } from "@lastthaw/shared";
import { fmt } from "./ui.js";

/**
 * How the hauling fleet is doing: what you have, where it is, what is waiting
 * on it, and whether you need more.
 */
export function LogisticsPanel({ state, onSelect }: { state: MatchStateView; onSelect: (regionId: string) => void }) {
  const fleet = useMemo(() => {
    const rows = HAULER_IDS.map((id) => {
      const home = state.owned.reduce((a, o) => a + (o.units[id] ?? 0), 0);
      const road = state.armies.reduce((a, x) => a + (x.units[id] ?? 0), 0);
      return { id, name: unitById.get(id)?.name ?? id, home, road, carry: haulerCarry(id, state.me.techs) };
    }).filter((r) => r.home + r.road > 0 || r.id === "caravan");
    return rows;
  }, [state.owned, state.armies, state.me.techs]);
  const totalHome = fleet.reduce((a, r) => a + r.home, 0);
  const totalRoad = fleet.reduce((a, r) => a + r.road, 0);
  const capacityHome = fleet.reduce((a, r) => a + r.home * r.carry, 0);

  const stalled = state.routes.filter((r) => r.enabled && (r.lastResult ?? "").startsWith("no haulers at home"));
  const waitingBuilds = state.jobs.filter((j) => j.kind === "build" && j.waitingFor);
  const owed = useMemo(() => {
    const t: Record<string, number> = {};
    for (const j of waitingBuilds) for (const [k, v] of Object.entries(j.waitingFor ?? {})) t[k] = (t[k] ?? 0) + v;
    return t;
  }, [waitingBuilds]);
  const fullNoHaulers = state.owned.filter((o) => !o.frozen && !o.isCapital && (["food", "wood", "stone"] as const).some((k) => o[k] >= o.storage[k] * 0.95) && HAULER_IDS.every((id) => (o.units[id] ?? 0) === 0));
  const idleRegions = state.owned.filter((o) => HAULER_IDS.some((id) => (o.units[id] ?? 0) > 0) && !state.routes.some((r) => r.enabled && r.fromRegionId === o.regionId));

  const verdict =
    stalled.length > 0 || fullNoHaulers.length > 0
      ? {
          tone: "text-amber-300",
          text: `Short of haulers: ${stalled.length} route${stalled.length === 1 ? "" : "s"} waiting and ${fullNoHaulers.length} full region${fullNoHaulers.length === 1 ? "" : "s"} with none at home. Train more under a region's Train tab${
            !state.me.techs.includes("wagon_building") ? ", or research Wagon building: it turns every caravan into a wagon that carries 1,200" : !state.me.techs.includes("railways") ? ", or research Railways in the Medieval Age: it turns every wagon into a train" : ""
          }.`,
        }
      : totalHome > 0 && totalRoad === 0 && state.routes.length === 0
        ? { tone: "text-slate-300", text: "Your haulers are all at home with nothing to do. Set up trade routes or let overflow use them." }
        : { tone: "text-emerald-400", text: "Hauling is keeping up: nothing is waiting on a caravan." };

  return (
    <div className="max-h-[70vh] space-y-3 overflow-auto p-3 text-sm">
      <p className={`text-xs ${verdict.tone}`}>{verdict.text}</p>

      <table className="w-full text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="py-1 text-left font-medium">Hauler</th>
            <th className="py-1 text-right font-medium">At home</th>
            <th className="py-1 text-right font-medium">On the road</th>
            <th className="py-1 text-right font-medium">Carries each</th>
          </tr>
        </thead>
        <tbody>
          {fleet.map((r) => (
            <tr key={r.id} className="border-t border-slate-900 text-slate-200">
              <td className="py-1">{r.name}</td>
              <td className="py-1 text-right tabular-nums">{r.home}</td>
              <td className="py-1 text-right tabular-nums">{r.road}</td>
              <td className="py-1 text-right tabular-nums">{fmt(r.carry)}</td>
            </tr>
          ))}
          <tr className="border-t border-slate-700 font-medium text-white">
            <td className="py-1">Total</td>
            <td className="py-1 text-right tabular-nums">{totalHome}</td>
            <td className="py-1 text-right tabular-nums">{totalRoad}</td>
            <td className="py-1 text-right tabular-nums">{fmt(capacityHome)} idle capacity</td>
          </tr>
        </tbody>
      </table>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Waiting on haulers</p>
          {stalled.length === 0 ? (
            <p className="text-xs text-slate-500">No routes are waiting.</p>
          ) : (
            <ul className="space-y-0.5 text-xs">
              {stalled.map((r) => (
                <li key={r.id}>
                  <button className="hover:text-white" onClick={() => onSelect(r.fromRegionId)}>
                    {regionById(r.fromRegionId)?.name} → {regionById(r.toRegionId)?.name}
                  </button>
                  <span className="text-slate-500"> · {r.lastResult}</span>
                </li>
              ))}
            </ul>
          )}
          {waitingBuilds.length > 0 && (
            <p className="mt-1 text-xs text-slate-400">
              {waitingBuilds.length} build{waitingBuilds.length === 1 ? "" : "s"} waiting for materials: {Object.entries(owed).map(([k, v]) => `${fmt(v)} ${k}`).join(", ")}
            </p>
          )}
        </div>
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Where more would help</p>
          {fullNoHaulers.length === 0 ? (
            <p className="text-xs text-slate-500">No full region is without a hauler.</p>
          ) : (
            <ul className="space-y-0.5 text-xs">
              {fullNoHaulers.map((o) => (
                <li key={o.regionId}>
                  <button className="hover:text-white" onClick={() => onSelect(o.regionId)}>
                    {regionById(o.regionId)?.name}
                  </button>
                  <span className="text-slate-500"> · stores full, no haulers</span>
                </li>
              ))}
            </ul>
          )}
          {idleRegions.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              Haulers sitting idle with no route in: {idleRegions.map((o) => regionById(o.regionId)?.name).join(", ")}. They are still used for overflow and relief.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
