import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { balance, regionById, unitById, type MatchStateView, type OwnedRegionView, type TradeRouteView, caravanCarry } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, ErrorText, fmt } from "./ui.js";
import { Countdown } from "./Countdown.js";

const GOODS = ["food", "wood", "stone", "copper", "tin", "iron", "horses"] as const;

/**
 * Automated caravan routes from this region: a list of existing routes and a
 * form to add one. "Tribute to capital" is a one-click preset.
 */
export function RoutesTab({ matchId, state, owned, clockOffsetMs, allRoutes = false }: { matchId: string; state: MatchStateView; owned: OwnedRegionView; clockOffsetMs: number; allRoutes?: boolean }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
  const routes = allRoutes ? state.routes : state.routes.filter((r) => r.fromRegionId === owned.regionId);
  const caravans = owned.units.caravan ?? 0;
  const perCaravan = caravanCarry(state.me.techs);
  const capital = state.me.capitalRegionId;

  // Destinations: my other regions and allies' regions we can see.
  const destinations = useMemo(() => {
    const mine = state.owned.filter((o) => o.regionId !== owned.regionId).map((o) => ({ id: o.regionId, label: `${regionById(o.regionId)?.name}${o.isCapital ? " (capital)" : ""}` }));
    const allied = state.sighted.filter((s) => s.ownerPlayerId && state.allies.includes(s.ownerPlayerId)).map((s) => ({ id: s.regionId, label: `${regionById(s.regionId)?.name} (${s.ownerName})` }));
    const settling = state.armies
      .filter((a) => a.mission === "settle" && a.status === "outbound" && !state.owned.some((o) => o.regionId === a.targetRegionId))
      .map((a) => ({ id: a.targetRegionId, label: `${regionById(a.targetRegionId)?.name} (settlers on the way)` }));
    return [...mine, ...allied, ...settling.filter((s, i) => settling.findIndex((x) => x.id === s.id) === i)];
  }, [state, owned.regionId]);

  const [to, setTo] = useState<string>(destinations[0]?.id ?? "");
  const [mode, setMode] = useState<"fixed" | "share" | "stockup">("fixed");
  const [load, setLoad] = useState<Record<string, number>>({ food: 0, wood: 200, stone: 0 });
  const [share, setShare] = useState(0.3);
  const [count, setCount] = useState(2);
  const [every, setEvery] = useState(2);
  const [editing, setEditing] = useState<TradeRouteView | null>(null);
  const startEdit = (r: TradeRouteView) => {
    setEditing(r);
    setTo(r.toRegionId);
    setMode(r.target ? "stockup" : r.mode);
    setLoad({ food: 0, wood: 0, stone: 0, ...r.load });
    setShare(r.share || 0.3);
    setCount(r.caravans);
    setEvery(r.everyHours);
  };
  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.updateRoute>[2]) => api.updateRoute(matchId, editing!.id, body),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });

  const create = useMutation({
    mutationFn: (body: Parameters<typeof api.createRoute>[2]) => api.createRoute(matchId, owned.regionId, body),
    onSuccess: refresh,
  });
  const toggle = useMutation({ mutationFn: (id: string) => api.toggleRoute(matchId, id), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteRoute(matchId, id), onSuccess: refresh });
  const run = useMutation({ mutationFn: (id: string) => api.runRoute(matchId, id), onSuccess: refresh });

  const tributePreset = () => {
    if (!capital) return;
    create.mutate({ toRegionId: capital, mode: "share", load: {}, share: 0.3, caravans: 10, everyHours: 2 });
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-400">
        {caravans} caravan{caravans === 1 ? "" : "s"} at home · each carries {perCaravan}. Train more under Train. Roads here and at the destination speed them up.
      </p>

      {routes.length > 0 && (
        <ul className="divide-y divide-slate-800">
          {routes.map((r) => (
            <RouteRow key={r.id} r={r} showFrom={allRoutes} editing={editing?.id === r.id} clockOffsetMs={clockOffsetMs} onToggle={() => toggle.mutate(r.id)} onDelete={() => remove.mutate(r.id)} onRun={() => run.mutate(r.id)} onEdit={() => startEdit(r)} />
          ))}
        </ul>
      )}
      {routes.length === 0 && <p className="text-slate-400">{allRoutes ? "No trade routes yet." : "No routes from here yet."}</p>}
      <ErrorText>{(toggle.error ?? remove.error ?? run.error)?.message}</ErrorText>

      <div className="space-y-2 border-t border-slate-800 pt-3">
        <h3 className="text-sm font-medium">{editing ? `Edit route from ${regionById(editing.fromRegionId)?.name}` : `New route from ${regionById(owned.regionId)?.name}`}</h3>
        {destinations.length === 0 ? (
          <p className="text-xs text-slate-400">You need a second region (or an ally) to send to.</p>
        ) : (
          <>
            <label className="grid grid-cols-[5rem_1fr] items-center gap-2">
              <span className="text-slate-400">To</span>
              <select value={to} onChange={(e) => setTo(e.target.value)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1">
                {destinations.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1">
              {(["fixed", "share", "stockup"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={`rounded px-2 py-1 text-xs ${mode === m ? "bg-sky-500 text-slate-950" : "bg-slate-800 text-slate-300"}`}>
                  {m === "fixed" ? "Fixed amounts" : m === "share" ? "Share of production" : "Stock-up totals"}
                </button>
              ))}
            </div>
            {mode !== "share" ? (
              <div className="grid grid-cols-2 gap-1">
                {GOODS.map((g) => (
                  <label key={g} className="flex items-center gap-2">
                    <span className="w-14 capitalize text-slate-400">{g}</span>
                    <input type="number" min={0} value={load[g] ?? 0} onChange={(e) => setLoad((l) => ({ ...l, [g]: Math.max(0, Number(e.target.value)) }))} className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1" />
                  </label>
                ))}
              </div>
            ) : (
              <label className="grid grid-cols-[5rem_1fr_3rem] items-center gap-2">
                <span className="text-slate-400">Share</span>
                <input type="range" min={1} max={Math.round(balance.tribute.maxShare * 100)} value={Math.round(share * 100)} onChange={(e) => setShare(Number(e.target.value) / 100)} className="accent-amber-400" />
                <span className="text-right tabular-nums">{Math.round(share * 100)}%</span>
              </label>
            )}
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2">
                <span className="text-slate-400">Caravans</span>
                <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value)))} className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1" />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-slate-400">Every</span>
                <input type="number" min={0.5} max={48} step={0.5} value={every} onChange={(e) => setEvery(Math.max(0.5, Number(e.target.value)))} className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1" />
                <span className="text-xs text-slate-500">game h</span>
              </label>
            </div>
            <p className="text-xs text-slate-500">
              {mode === "stockup"
                ? `Delivers these totals in trips of up to ${count} caravans (${fmt(count * perCaravan)} goods), one trip per game hour while caravans are home, then the route removes itself. Works for a region your settlers are still walking to.`
                : `Up to ${count} caravans (${fmt(count * perCaravan)} goods) leave every ${every} game hours, unload, and come back. Trips are skipped when nothing is in stock or no caravans are home.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {editing ? (
                <>
                  <Button disabled={update.isPending || !to || mode === "stockup"} onClick={() => update.mutate({ toRegionId: to, mode: mode === "share" ? "share" : "fixed", load: mode === "share" ? {} : load, share: mode === "share" ? share : 0, caravans: count, everyHours: every })}>
                    Save changes
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  disabled={create.isPending || !to}
                  onClick={() =>
                    create.mutate({
                      toRegionId: to,
                      mode: mode === "share" ? "share" : "fixed",
                      load: mode === "share" ? {} : load,
                      share: mode === "share" ? share : 0,
                      caravans: count,
                      everyHours: every,
                      ...(mode === "stockup" ? { target: load } : {}),
                    })
                  }
                >
                  {mode === "stockup" ? "Start stock-up" : "Add route"}
                </Button>
              )}
              {capital && capital !== owned.regionId && (
                <Button variant="ghost" disabled={create.isPending} onClick={tributePreset} title="30% of production to the capital every 2 game hours with up to 10 caravans">
                  Tribute to capital
                </Button>
              )}
            </div>
            <ErrorText>{(create.error ?? update.error)?.message}</ErrorText>
          </>
        )}
      </div>
    </div>
  );
}

function RouteRow({ r, showFrom, editing, clockOffsetMs, onToggle, onDelete, onRun, onEdit }: { r: TradeRouteView; showFrom?: boolean; editing?: boolean; clockOffsetMs: number; onToggle: () => void; onDelete: () => void; onRun: () => void; onEdit: () => void }) {
  const what = r.target
    ? "stock-up " +
      Object.entries(r.target)
        .map(([k, v]) => `${Math.round(r.delivered[k] ?? 0)}/${v} ${k}`)
        .join(", ")
    : r.mode === "share"
      ? `${Math.round(r.share * 100)}% of production`
      : Object.entries(r.load)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ");
  return (
    <li className={`space-y-0.5 py-2 ${editing ? "rounded bg-slate-800/50 px-2" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={r.enabled ? "" : "text-slate-500 line-through"}>
          {showFrom ? `${regionById(r.fromRegionId)?.name} ` : ""}→ {regionById(r.toRegionId)?.name}: {what}
        </span>
        <span className="text-xs text-slate-500">
          {r.caravans} caravans · every {r.everyHours}h
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          {r.enabled ? (
            <>
              next <Countdown to={r.nextAt} clockOffsetMs={clockOffsetMs} />
            </>
          ) : (
            "paused"
          )}
          {r.lastResult ? ` · last: ${r.lastResult}` : ""}
        </span>
        <span className="flex gap-2">
          <button className="hover:text-white" onClick={onEdit}>
            edit
          </button>
          <button className="hover:text-white" onClick={onRun}>
            send now
          </button>
          <button className="hover:text-white" onClick={onToggle}>
            {r.enabled ? "pause" : "resume"}
          </button>
          <button className="hover:text-rose-400" onClick={onDelete}>
            delete
          </button>
        </span>
      </div>
    </li>
  );
}
