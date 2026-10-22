import { useMemo } from "react";
import { balance, HAULER_IDS, haulerCarry, regionById, supplyConvoyCap, unitById, type MatchStateView } from "@lastthaw/shared";
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

  const stalled = state.routes.filter((r) => r.enabled && (r.lastResult ?? "").startsWith("no haulers at home"));
  const waitingBuilds = state.jobs.filter((j) => j.kind === "build" && j.waitingFor);
  const owed = useMemo(() => {
    const t: Record<string, number> = {};
    for (const j of waitingBuilds) for (const [k, v] of Object.entries(j.waitingFor ?? {})) t[k] = (t[k] ?? 0) + v;
    return t;
  }, [waitingBuilds]);
  const fullNoHaulers = state.owned.filter((o) => !o.frozen && !o.isCapital && (["food", "wood", "stone"] as const).some((k) => o[k] >= o.storage[k] * 0.95) && HAULER_IDS.every((id) => (o.units[id] ?? 0) === 0));
  const idleRegions = state.owned.filter((o) => HAULER_IDS.some((id) => (o.units[id] ?? 0) > 0) && !state.routes.some((r) => r.enabled && r.fromRegionId === o.regionId));

  // Materials convoys are capped by the fleet's size; routes past the cap wait their turn, and that is not "keeping up".
  const convoyCap = supplyConvoyCap(totalHome + totalRoad);
  const outConvoys = state.armies.filter((a) => a.mission === "transport" && a.status === "outbound" && a.stops.length > 0).length;
  const waitingTurn = state.routes.filter((r) => r.enabled && (r.lastResult ?? "").startsWith("waiting:")).length;
  const verdict =
    stalled.length > 0 || fullNoHaulers.length > 0
      ? {
          tone: "text-amber-300",
          text: `Short of haulers: ${stalled.length} route${stalled.length === 1 ? "" : "s"} waiting and ${fullNoHaulers.length} full region${fullNoHaulers.length === 1 ? "" : "s"} with none at home. Train more under a region's Train tab${
            !state.me.techs.includes("wagon_building") ? ", or research Wagon building: it turns every caravan into a wagon that carries 1,200" : ", or research the next hauler tech (Wainwrights, Railways, Internal combustion): each rebuilds your whole fleet as the better kind"
          }.`,
        }
      : waitingTurn > 0
        ? {
            tone: "text-amber-300",
            text: `${outConvoys} of ${convoyCap} materials convoys are out and ${waitingTurn} route${waitingTurn === 1 ? "" : "s"} wait their turn. Every ${balance.trade.supplyConvoysPerHaulers} haulers you own raise the cap by one.`,
          }
      : totalHome > 0 && totalRoad === 0 && state.routes.length === 0
        ? { tone: "text-slate-300", text: "Your haulers are all at home with nothing to do. Set up trade routes or let overflow use them." }
        : { tone: "text-emerald-400", text: "Hauling is keeping up: nothing is waiting on a caravan." };

  const have = totalHome + totalRoad;
  // Materials routes: the ones bringing goods to waiting builds, with what is still to come on each.
  const supply = state.routes.filter((r) => r.target).map((r) => {
    const left: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.target ?? {})) if (v - (r.delivered[k] ?? 0) >= 1) left[k] = v - (r.delivered[k] ?? 0);
    return { ...r, left };
  });
  const idleCount = idleRegions.reduce((a, o) => a + HAULER_IDS.reduce((x, id) => x + (o.units[id] ?? 0), 0), 0);
  // Where the haulers at home actually are: ships serve sea legs only; land haulers are either claimed by the routes of the
  // region they stand in (the count those routes ask for) or spare, which is what the pool can call elsewhere.
  const landIds = HAULER_IDS.filter((id) => !unitById.get(id)?.naval);
  const shipsHome = state.owned.reduce((a, o) => a + HAULER_IDS.filter((id) => unitById.get(id)?.naval).reduce((x, id) => x + (o.units[id] ?? 0), 0), 0);
  let claimedHome = 0;
  let spareHome = 0;
  for (const o of state.owned) {
    const land = landIds.reduce((x, id) => x + (o.units[id] ?? 0), 0);
    const asked = state.routes.filter((r) => r.enabled && r.fromRegionId === o.regionId).reduce((x, r) => x + r.caravans, 0);
    const claimed = Math.min(land, asked);
    claimedHome += claimed;
    spareHome += land - claimed;
  }
  const spareCapacity = state.owned.reduce((a, o) => {
    const asked = state.routes.filter((r) => r.enabled && r.fromRegionId === o.regionId).reduce((x, r) => x + r.caravans, 0);
    let left = Math.max(0, landIds.reduce((x, id) => x + (o.units[id] ?? 0), 0) - asked);
    let cap = 0;
    for (const id of landIds) {
      const take = Math.min(left, o.units[id] ?? 0);
      cap += take * haulerCarry(id, state.me.techs);
      left -= take;
      if (left <= 0) break;
    }
    return a + cap;
  }, 0);
  // What is wanted right now: the haulers the stalled routes ask for at their origins, and one per full region with none.
  const stalledNeed = stalled.reduce((a, r) => a + r.caravans, 0);
  // Collecting convoys: one trip, several pickups.
  const convoys = state.armies.filter((a) => a.mission === "transport" && a.status === "outbound" && a.stops.length > 0);

  return (
    <div className="space-y-3 p-3 text-sm">
      <div className="rounded-md border border-slate-800 bg-slate-900/60 p-3">
        <p className="text-base text-slate-100">
          You have <span className="font-semibold">{have}</span> hauler{have === 1 ? "" : "s"}
          {fleet.filter((r) => r.home + r.road > 0).length > 0 && (
            <span className="text-slate-400"> ({fleet.filter((r) => r.home + r.road > 0).map((r) => `${r.home + r.road} ${r.name.toLowerCase()}${r.home + r.road === 1 ? "" : "s"}`).join(", ")})</span>
          )}
          : {totalRoad} on the road, {totalHome} at home.
        </p>
        <p className="mt-1 text-xs text-slate-300">
          Of the {totalHome} at home: <span className="text-slate-100">{claimedHome}</span> are claimed by the routes of the region they stand in, <span className="text-slate-100">{spareHome}</span> are spare (carrying up to {fmt(spareCapacity)}){shipsHome > 0 ? <>, and <span className="text-slate-100">{shipsHome}</span> are ships, which serve sea legs only</> : null}.
          {stalled.length > 0 || fullNoHaulers.length > 0 ? (
            <>
              {" "}Wanted now: {stalledNeed} at the origins of the {stalled.length} waiting route{stalled.length === 1 ? "" : "s"}, and at least one in each of the {fullNoHaulers.length} full region{fullNoHaulers.length === 1 ? "" : "s"} with none.
            </>
          ) : null}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Spare haulers are called over by the routes that need them, nearest first, but only {balance.trade.maxReliefMoves} such moves are on the road at once, so a big shortfall clears slowly: move idle ones yourself, or train where they are needed. To make trips shorter, build Waystations (Iron Age, on Roads) in the regions your convoys arrive in most: each level cuts those legs by 2%, up to 30%, and the savings multiply along a route.
        </p>
      </div>
      <p className={`text-xs ${verdict.tone}`}>{verdict.text}</p>
      {convoys.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Convoys collecting for builds</p>
          <ul className="space-y-0.5 text-xs">
            {convoys.map((a) => {
              const dest = a.stops[a.stops.length - 1]!.regionId;
              const calls = a.stops.filter((s) => !s.done && s.routeId).map((s) => regionById(s.regionId)?.name ?? s.regionId);
              const aboard = Object.entries(a.cargo).filter(([k, v]) => k !== "people" && v > 0);
              return (
                <li key={a.id}>
                  <button className="hover:text-white" onClick={() => onSelect(a.targetRegionId)}>
                    {Object.entries(a.units).map(([id, n]) => `${n} ${unitById.get(id)?.name.toLowerCase() ?? id}${n === 1 ? "" : "s"}`).join(", ")} → {regionById(dest)?.name}
                  </button>
                  <span className="text-slate-500">
                    {" "}· {aboard.length ? aboard.map(([k, v]) => `${fmt(v)} ${k}`).join(", ") + " aboard" : "empty"}
                    {calls.length ? `, calling at ${calls.join(", ")}` : ", on the final leg"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {supply.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Materials on the way to builds</p>
          <ul className="space-y-0.5 text-xs">
            {supply.map((r) => (
              <li key={r.id}>
                <button className="hover:text-white" onClick={() => onSelect(r.toRegionId)}>
                  {regionById(r.fromRegionId)?.name} → {regionById(r.toRegionId)?.name}{r.relayTo && r.relayTo !== r.toRegionId ? ` (bound for ${regionById(r.relayTo)?.name})` : ""}
                </button>
                <span className="text-slate-400"> · {Object.entries(r.left).map(([k, v]) => `${fmt(v)} ${k}`).join(", ") || "delivered"} still to come{Object.values(r.held).some((v) => v > 0) ? ` (${Object.entries(r.held).filter(([, v]) => v > 0).map(([k, v]) => `${fmt(v)} ${k}`).join(", ")} set aside at ${regionById(r.fromRegionId)?.name})` : ""}, {r.caravans} hauler{r.caravans === 1 ? "" : "s"} per trip</span>
                {r.lastResult && <span className="text-slate-500"> · {r.lastResult}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto">
      <table className="w-full min-w-max text-xs">
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
      </div>

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
                    {regionById(r.fromRegionId)?.name} → {regionById(r.toRegionId)?.name}{r.relayTo && r.relayTo !== r.toRegionId ? ` (bound for ${regionById(r.relayTo)?.name})` : ""}
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
              {idleCount} hauler{idleCount === 1 ? "" : "s"} with no route of their own in {idleRegions.map((o) => regionById(o.regionId)?.name).join(", ")}: the first to be called when any route runs short.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
