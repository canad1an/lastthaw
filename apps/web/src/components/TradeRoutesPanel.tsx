import { useEffect, useState } from "react";
import { regionById, type MatchStateView } from "@lastthaw/shared";
import { Card } from "./ui.js";
import { RoutesTab } from "./RoutesTab.js";

/** Side-panel card: every trade route, plus a form to add one from any of your regions. */
export function TradeRoutesPanel({ matchId, state, selectedRegionId, clockOffsetMs }: { matchId: string; state: MatchStateView; selectedRegionId: string | null; clockOffsetMs: number }) {
  const [open, setOpen] = useState(false);
  const ownedSelected = state.owned.find((o) => o.regionId === selectedRegionId);
  const [fromId, setFromId] = useState<string>(ownedSelected?.regionId ?? state.me.capitalRegionId ?? state.owned[0]?.regionId ?? "");
  useEffect(() => {
    if (ownedSelected) setFromId(ownedSelected.regionId);
  }, [ownedSelected]);
  const from = state.owned.find((o) => o.regionId === fromId) ?? state.owned[0];
  const caravansTotal = state.owned.reduce((a, o) => a + (o.units.caravan ?? 0), 0);
  const inFlight = state.armies.filter((a) => a.mission === "transport").length;

  return (
    <Card className="space-y-2">
      <button className="flex w-full items-center justify-between text-sm font-medium" onClick={() => setOpen((o) => !o)}>
        <span>Trade Routes</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
          {state.routes.length} route{state.routes.length === 1 ? "" : "s"} · {caravansTotal} caravans{inFlight ? ` · ${inFlight} on the road` : ""}
        </span>
      </button>
      {open && (
        <>
          {state.owned.length > 0 && from ? (
            <>
              <label className="grid grid-cols-[5rem_1fr] items-center gap-2 text-sm">
                <span className="text-slate-400">From</span>
                <select value={from.regionId} onChange={(e) => setFromId(e.target.value)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1">
                  {state.owned.map((o) => (
                    <option key={o.regionId} value={o.regionId}>
                      {regionById(o.regionId)?.name}
                      {o.isCapital ? " (capital)" : ""} · {o.units.caravan ?? 0} caravans
                    </option>
                  ))}
                </select>
              </label>
              <RoutesTab matchId={matchId} state={state} owned={from} clockOffsetMs={clockOffsetMs} allRoutes />
            </>
          ) : (
            <p className="text-sm text-slate-400">You need a region to trade from.</p>
          )}
        </>
      )}
    </Card>
  );
}
