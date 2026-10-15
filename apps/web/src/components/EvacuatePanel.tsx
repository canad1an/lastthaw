import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { balance, carryCapacity, distanceKm, freezeDayForLatitude, iceDaysFor, regionById, type MatchStateView, type OwnedRegionView, caravanCarry } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, ErrorText, fmt } from "./ui.js";

/**
 * Ice status for an owned region, and an Evacuate action: everyone, every unit
 * and as much stock as they can carry move to a region of your choosing.
 */
export function EvacuatePanel({ matchId, state, owned, matchDay }: { matchId: string; state: MatchStateView; owned: OwnedRegionView; matchDay: number }) {
  const qc = useQueryClient();
  const region = regionById(owned.regionId)!;
  const { touch: touchDay, freeze: freezeDay } = iceDaysFor(region);
  const daysLeft = freezeDay === null ? null : freezeDay - matchDay;
  const touchLeft = touchDay === null ? null : touchDay - matchDay;
  const urgent = owned.frozen || (touchLeft !== null && touchLeft <= 3) || owned.iceFactor < 1;
  const [open, setOpen] = useState(false);

  // Destinations: my other regions, safest (latest freeze) and nearest first.
  const destinations = useMemo(() => {
    const safety = (id: string) => freezeDayForLatitude(Math.abs(regionById(id)!.lat)) ?? 999;
    return state.owned
      .filter((o) => o.regionId !== owned.regionId && !o.frozen)
      .map((o) => ({ id: o.regionId, name: regionById(o.regionId)!.name, freeze: safety(o.regionId), km: distanceKm(owned.regionId, o.regionId), capital: o.isCapital }))
      .sort((a, b) => (b.freeze === a.freeze ? a.km - b.km : b.freeze - a.freeze));
  }, [state.owned, owned.regionId]);
  const [to, setTo] = useState<string>(destinations[0]?.id ?? "");
  const dest = destinations.find((d) => d.id === to) ?? destinations[0];

  const people = Math.floor(owned.popWorkers + owned.popOccupiers);
  const units = Object.fromEntries(Object.entries(owned.units).filter(([, n]) => n > 0));
  const unitCount = Object.values(units).reduce((a, b) => a + b, 0);
  const capacity = carryCapacity(units, state.me.techs) + people * balance.travel.carryPerPerson;
  const stock = owned.food + owned.wood + owned.stone + Object.values(owned.special).reduce((a, b) => a + b, 0);

  const m = useMutation({
    mutationFn: () => api.evacuate(matchId, owned.regionId, dest!.id),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
    },
  });

  // All hooks above run every render; only then may the evacuated state short-circuit.
  if (owned.evacuated) {
    return (
      <div className="border-t border-slate-800 pt-3 text-sm text-slate-400">
        Evacuated{owned.frozen ? " and frozen" : ""}. Whatever was left is being carried to the capital; once the ice takes the region, the rest is lost.
        {!owned.frozen && " Move people back in to make it a home again."}
      </div>
    );
  }

  return (
    <div className={`space-y-2 border-t border-slate-800 pt-3 ${urgent ? "rounded-md border border-cyan-300/40 bg-cyan-200/5 p-2" : ""}`}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className={urgent ? "text-cyan-100" : "text-slate-300"}>
          {owned.frozen
            ? "Frozen. Nothing grows here and people are dying."
            : freezeDay === null
              ? "The ice never reaches this region."
              : owned.iceFactor < 1
                ? `Ice is crossing this region: producing at ${Math.round(owned.iceFactor * 100)}%. Fully frozen on day ${freezeDay} (${Math.max(0, daysLeft!).toFixed(1)} days).`
                : touchDay !== null && touchDay < freezeDay
                  ? `Ice touches this region on day ${touchDay} (${Math.max(0, touchLeft!).toFixed(1)} days), fully frozen on day ${freezeDay}.`
                  : `Ice arrives on day ${freezeDay} (${Math.max(0, daysLeft!).toFixed(1)} days from now).`}
        </span>
        {(people > 0 || unitCount > 0) && (
          <Button variant={urgent ? "primary" : "ghost"} onClick={() => setOpen((o) => !o)}>
            Evacuate
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-2 text-sm">
          {destinations.length === 0 ? (
            <p className="text-slate-400">No other unfrozen region to go to. Settle or conquer land further south first.</p>
          ) : (
            <>
              <label className="grid grid-cols-[4rem_1fr] items-center gap-2">
                <span className="text-slate-400">To</span>
                <select value={dest?.id ?? ""} onChange={(e) => setTo(e.target.value)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1">
                  {destinations.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.capital ? " (capital)" : ""} · {d.freeze >= 900 ? "never freezes" : `freezes day ${d.freeze}`} · {Math.round(d.km)} km
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-slate-400">
                Everyone leaves: {fmt(people)} people and {unitCount} units, carrying up to {fmt(capacity)} of the {fmt(stock)} in store (food first). Caravans carry {caravanCarry(state.me.techs)} each, people {balance.travel.carryPerPerson} each; train caravans first if you want to save more. The region stays yours but empty.
              </p>
              <Button variant="danger" disabled={m.isPending || !dest} onClick={() => m.mutate()}>
                Evacuate to {dest?.name}
              </Button>
            </>
          )}
          <ErrorText>{m.error?.message}</ErrorText>
        </div>
      )}
    </div>
  );
}
