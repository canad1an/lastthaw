import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { balance, distanceKm, formatCountdown, regionById, unitById, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, ErrorText } from "./ui.js";

/**
 * Shown when an unclaimed frontier region is selected: choose which of your
 * regions sends settlers and how many, then colonize.
 */
export function ColonizePanel({ matchId, state, regionId }: { matchId: string; state: MatchStateView; regionId: string }) {
  const qc = useQueryClient();
  const need = balance.settle.settlersRequired;
  const target = regionById(regionId)!;
  // Candidate sources: owned regions with enough settlers, nearest first.
  const sources = useMemo(
    () =>
      state.owned
        .filter((o) => (o.units.settler ?? 0) >= need)
        .sort((a, b) => distanceKm(a.regionId, regionId) - distanceKm(b.regionId, regionId)),
    [state.owned, regionId, need],
  );
  const [sourceId, setSourceId] = useState<string | null>(sources[0]?.regionId ?? null);
  useEffect(() => {
    if (!sourceId || !sources.some((s) => s.regionId === sourceId)) setSourceId(sources[0]?.regionId ?? null);
  }, [sources, sourceId]);
  const source = sources.find((s) => s.regionId === sourceId) ?? null;
  const available = source?.units.settler ?? 0;
  const [count, setCount] = useState<number>(need);
  useEffect(() => setCount((c) => Math.min(Math.max(need, c), Math.max(need, available))), [available, need]);

  const speed = unitById.get("settler")?.speed ?? 4;
  const route = useQuery({
    queryKey: ["route", matchId, sourceId, regionId, speed],
    queryFn: () => fetch(`/api/matches/${matchId}/route?from=${sourceId}&to=${regionId}&speed=${speed}`, { credentials: "include" }).then((r) => r.json() as Promise<{ seconds?: number; error?: string }>),
    enabled: !!sourceId,
  });
  const send = useMutation({
    mutationFn: () => api.sendArmy(matchId, sourceId!, { mission: "settle", targetRegionId: regionId, units: { settler: count }, people: 0, cargo: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });

  const totalSettlers = state.owned.reduce((a, o) => a + (o.units.settler ?? 0), 0);

  return (
    <div className="space-y-3 rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-sm">
      <div>
        <h3 className="font-medium text-amber-200">Unclaimed land</h3>
        <p className="text-xs text-slate-400">
          Nobody lives in {target.name}. {need} settlers can claim it and become its first workers.
        </p>
      </div>
      {sources.length === 0 ? (
        <p className="text-xs text-slate-300">
          You have {totalSettlers} settler{totalSettlers === 1 ? "" : "s"}; you need {need} in one region. Train them under a region's <span className="text-white">Train</span> tab (groups of {need}).
        </p>
      ) : (
        <>
          <label className="flex items-center gap-2">
            <span className="w-16 text-slate-400">From</span>
            <select value={sourceId ?? ""} onChange={(e) => setSourceId(e.target.value)} className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1">
              {sources.map((s) => (
                <option key={s.regionId} value={s.regionId}>
                  {regionById(s.regionId)?.name} · {s.units.settler} settlers
                </option>
              ))}
            </select>
          </label>
          <label className="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
            <span className="text-slate-400">Settlers</span>
            <input type="range" min={need} max={Math.max(need, available)} value={count} onChange={(e) => setCount(Number(e.target.value))} className="accent-amber-400" />
            <span className="text-right tabular-nums">{count}</span>
          </label>
          <p className="text-xs text-slate-400">
            {count} people will found the colony{count > need ? ` (${count - need} more than the minimum, all become workers)` : ""}.
            {route.data?.seconds !== undefined ? ` Travel: ${formatCountdown(route.data.seconds)}.` : ""}
            {route.data?.error ? ` ${route.data.error}.` : ""}
          </p>
          <Button disabled={send.isPending || !!route.data?.error || !sourceId} onClick={() => send.mutate()}>
            Colonize {target.name}
          </Button>
          {send.isSuccess && <p className="text-xs text-emerald-400">Settlers are on their way. Watch them under In progress.</p>}
          <ErrorText>{send.error?.message}</ErrorText>
        </>
      )}
    </div>
  );
}
