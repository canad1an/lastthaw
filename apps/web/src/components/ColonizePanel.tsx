import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { balance, distanceKm, formatCountdown, regionById, unitById, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, ErrorText } from "./ui.js";

/** The last stock-up settings used on this device, so the form does not reset to defaults each time. */
const STOCK_KEY = "lt_stockup";
type StockPrefs = { stock: Record<string, number>; caravans: number; stockUp: boolean };
function loadStockPrefs(): StockPrefs {
  try {
    const raw = localStorage.getItem(STOCK_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<StockPrefs>;
      return { stock: { food: 300, wood: 300, stone: 100, ...(v.stock ?? {}) }, caravans: Math.max(1, Number(v.caravans) || 2), stockUp: !!v.stockUp };
    }
  } catch {
    // ignore
  }
  return { stock: { food: 300, wood: 300, stone: 100 }, caravans: 2, stockUp: false };
}
function saveStockPrefs(p: StockPrefs): void {
  try {
    localStorage.setItem(STOCK_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

/**
 * Shown when an unclaimed frontier region is selected: choose which of your
 * regions sends settlers and how many, then colonize.
 */
export function ColonizePanel({ matchId, state, regionId }: { matchId: string; state: MatchStateView; regionId: string }) {
  const settling = state.armies.find((a) => a.mission === "settle" && a.status === "outbound" && a.targetRegionId === regionId);
  if (settling) return <SettlingPanel matchId={matchId} state={state} regionId={regionId} armyOrigin={settling.originRegionId} arrivesAt={settling.arrivesAt} />;
  return <ColonizeForm matchId={matchId} state={state} regionId={regionId} />;
}

/** Settlers are already walking there: show the arrival and let the player set up (or watch) a stock-up. */
function SettlingPanel({ matchId, state, regionId, armyOrigin, arrivesAt }: { matchId: string; state: MatchStateView; regionId: string; armyOrigin: string; arrivesAt: string }) {
  const qc = useQueryClient();
  const target = regionById(regionId)!;
  const existing = state.routes.filter((r) => r.toRegionId === regionId && r.target);
  const sources = useMemo(
    () => state.owned.filter((o) => (o.units.caravan ?? 0) >= 1).sort((a, b) => (a.regionId === armyOrigin ? -1 : b.regionId === armyOrigin ? 1 : distanceKm(a.regionId, regionId) - distanceKm(b.regionId, regionId))),
    [state.owned, armyOrigin, regionId],
  );
  const [sourceId, setSourceId] = useState<string>(sources[0]?.regionId ?? "");
  useEffect(() => {
    if (!sourceId || !sources.some((s) => s.regionId === sourceId)) setSourceId(sources[0]?.regionId ?? "");
  }, [sources, sourceId]);
  const source = sources.find((s) => s.regionId === sourceId);
  const caravansHome = source?.units.caravan ?? 0;
  const perCaravan = unitById.get("caravan")?.carry ?? 500;
  const [prefs] = useState(loadStockPrefs);
  const [stock, setStock] = useState<Record<string, number>>(prefs.stock);
  const [caravans, setCaravans] = useState(prefs.caravans);
  useEffect(() => setCaravans((c) => Math.max(1, Math.min(c, Math.max(1, caravansHome)))), [caravansHome]);
  const stockTotal = Object.values(stock).reduce((a, b) => a + b, 0);
  const trips = Math.ceil(stockTotal / (perCaravan * Math.max(1, Math.min(caravans, caravansHome))));
  const create = useMutation({
    mutationFn: () => {
      saveStockPrefs({ stock, caravans, stockUp: true });
      return api.createRoute(matchId, sourceId, { toRegionId: regionId, mode: "fixed", load: stock, share: 0, caravans, everyHours: 1, target: stock });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  const secondsLeft = Math.max(0, (Date.parse(arrivesAt) - Date.now()) / 1000);
  return (
    <div className="space-y-3 rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-sm">
      <div>
        <h3 className="font-medium text-amber-200">Settlers on the way</h3>
        <p className="text-xs text-slate-400">
          Your settlers reach {target.name} in {formatCountdown(secondsLeft)}. The colony becomes yours when they arrive.
        </p>
      </div>
      {existing.length > 0 ? (
        <div className="text-xs text-slate-300">
          Stock-up in progress from {existing.map((r) => regionById(r.fromRegionId)?.name).join(", ")}:{" "}
          {existing
            .flatMap((r) => Object.entries(r.target!).map(([k, v]) => `${Math.round(r.delivered[k] ?? 0)}/${v} ${k}`))
            .join(", ")}
          . Manage it under Trade Routes.
        </div>
      ) : sources.length === 0 ? (
        <p className="text-xs text-slate-400">To stock the colony by caravan, train caravans in one of your regions first, then come back here.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-slate-300">Stock the colony by caravan once founded:</p>
          <label className="flex items-center gap-2">
            <span className="w-16 text-slate-400">From</span>
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1">
              {sources.map((s) => (
                <option key={s.regionId} value={s.regionId}>
                  {regionById(s.regionId)?.name} · {s.units.caravan} caravans
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(["food", "wood", "stone"] as const).map((res) => (
              <label key={res} className="flex flex-col gap-0.5 text-xs text-slate-400">
                {res}
                <input type="number" min={0} step={50} value={stock[res] ?? 0} onChange={(e) => setStock((s) => ({ ...s, [res]: Math.max(0, Number(e.target.value) || 0) }))} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-sm text-white" />
              </label>
            ))}
          </div>
          <label className="grid grid-cols-[5rem_1fr_3rem] items-center gap-2">
            <span className="text-xs text-slate-400">Caravans</span>
            <input type="range" min={1} max={Math.max(1, caravansHome)} value={caravans} onChange={(e) => setCaravans(Number(e.target.value))} className="accent-amber-400" />
            <span className="text-right tabular-nums">{caravans}</span>
          </label>
          <p className="text-xs text-slate-400">
            {stockTotal} goods in about {trips} trip{trips === 1 ? "" : "s"}, starting when the settlers arrive. The route removes itself when the totals are delivered.
          </p>
          <Button disabled={create.isPending || stockTotal < 1 || !sourceId} onClick={() => create.mutate()}>
            Start stock-up
          </Button>
          <ErrorText>{create.error?.message}</ErrorText>
        </div>
      )}
    </div>
  );
}

function ColonizeForm({ matchId, state, regionId }: { matchId: string; state: MatchStateView; regionId: string }) {
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
  const caravansHome = source?.units.caravan ?? 0;
  const perCaravan = unitById.get("caravan")?.carry ?? 500;
  const [prefs] = useState(loadStockPrefs);
  const [stockUp, setStockUp] = useState(prefs.stockUp);
  const [stock, setStock] = useState<Record<string, number>>(prefs.stock);
  const [caravans, setCaravans] = useState(prefs.caravans);
  useEffect(() => setCaravans((c) => Math.max(1, Math.min(c, Math.max(1, caravansHome)))), [caravansHome]);
  const stockTotal = Object.values(stock).reduce((a, b) => a + b, 0);
  const trips = Math.ceil(stockTotal / (perCaravan * Math.max(1, Math.min(caravans, caravansHome))));
  const send = useMutation({
    mutationFn: () => {
      saveStockPrefs({ stock, caravans, stockUp });
      return api.colonize(matchId, sourceId!, {
        targetRegionId: regionId,
        settlers: count,
        ...(stockUp && stockTotal > 0 ? { stock, caravans } : {}),
      });
    },
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
          <div className="space-y-2 rounded border border-slate-800 bg-slate-900/50 p-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={stockUp} disabled={caravansHome < 1} onChange={(e) => setStockUp(e.target.checked)} className="accent-amber-400" />
              <span className={caravansHome < 1 ? "text-slate-500" : ""}>Stock the colony by caravan once founded</span>
            </label>
            {caravansHome < 1 ? (
              <p className="text-xs text-slate-500">Needs at least one caravan in {source ? regionById(source.regionId)?.name : "the source region"}. Train caravans under the Train tab.</p>
            ) : (
              stockUp && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    {(["food", "wood", "stone"] as const).map((res) => (
                      <label key={res} className="flex flex-col gap-0.5 text-xs text-slate-400">
                        {res}
                        <input
                          type="number"
                          min={0}
                          step={50}
                          value={stock[res] ?? 0}
                          onChange={(e) => setStock((s) => ({ ...s, [res]: Math.max(0, Number(e.target.value) || 0) }))}
                          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-sm text-white"
                        />
                      </label>
                    ))}
                  </div>
                  <label className="grid grid-cols-[5rem_1fr_3rem] items-center gap-2">
                    <span className="text-xs text-slate-400">Caravans</span>
                    <input type="range" min={1} max={Math.max(1, caravansHome)} value={caravans} onChange={(e) => setCaravans(Number(e.target.value))} className="accent-amber-400" />
                    <span className="text-right tabular-nums">{caravans}</span>
                  </label>
                  <p className="text-xs text-slate-400">
                    {stockTotal} goods in about {trips} trip{trips === 1 ? "" : "s"} ({perCaravan} per caravan, one trip per game hour while caravans are home). The route removes itself when the totals arrive.
                  </p>
                </>
              )
            )}
          </div>
          <Button disabled={send.isPending || !!route.data?.error || !sourceId} onClick={() => send.mutate()}>
            Colonize {target.name}
          </Button>
          {send.isSuccess && <p className="text-xs text-emerald-400">Settlers are on their way. Watch them under In progress{stockUp && stockTotal > 0 ? "; the stock-up route is under Trade Routes" : ""}.</p>}
          <ErrorText>{send.error?.message}</ErrorText>
        </>
      )}
    </div>
  );
}
