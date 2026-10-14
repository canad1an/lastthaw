import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { armySpeed, balance, regionById, unitById, formatCountdown, type MatchStateView, type MissionKind, type OwnedRegionView, missionLabel } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, fmt } from "./ui.js";
import { Countdown } from "./Countdown.js";

const MISSIONS: Array<{ id: MissionKind; label: string; hint: string }> = [
  { id: "settle", label: "Settle", hint: "Send 5+ settlers to claim empty land; they become its first workers." },
  { id: "raid", label: "Raid", hint: "Fight, then carry off unprotected stock." },
  { id: "conquer", label: "Conquer", hint: "Fight, then settlers you bring occupy the region (at least five)." },
  { id: "scout", label: "Scout", hint: "Look at the region and come back." },
  { id: "move", label: "Move", hint: "Station units in your own or an ally's region." },
  { id: "reinforce", label: "Reinforce", hint: "Same as move, for allies." },
  { id: "transport", label: "Send resources", hint: "Caravans (500 each) carry goods to your own or an ally's region. For regular deliveries use the Routes tab." },
];

/** Compose and send an army from an owned region. The target is picked on the map. */
export function SendArmy({
  matchId,
  state,
  owned,
  target,
  onPickTarget,
  onClearTarget,
  clockOffsetMs,
}: {
  matchId: string;
  state: MatchStateView;
  owned: OwnedRegionView;
  target: string | null;
  onPickTarget: (picking: boolean) => void;
  onClearTarget: () => void;
  clockOffsetMs: number;
}) {
  const qc = useQueryClient();
  const [mission, setMission] = useState<MissionKind>("raid");
  const [units, setUnits] = useState<Record<string, number>>({});
  const [people, setPeople] = useState(0);
  const [cargo, setCargo] = useState<Record<string, number>>({});
  const [picking, setPicking] = useState(false);
  useEffect(() => onPickTarget(picking), [picking, onPickTarget]);
  useEffect(() => {
    if (target) setPicking(false);
  }, [target]);

  const available = Object.entries(owned.units).filter(([, n]) => n > 0);
  const chosen = Object.fromEntries(Object.entries(units).filter(([, n]) => n > 0));
  const speed = Object.keys(chosen).length ? armySpeed(chosen) : 5;
  const route = useQuery({
    queryKey: ["route", matchId, owned.regionId, target, speed],
    queryFn: () => fetch(`/api/matches/${matchId}/route?from=${owned.regionId}&to=${target}&speed=${speed}`, { credentials: "include" }).then((r) => r.json() as Promise<{ seconds?: number; path?: string[]; usesSea?: boolean; error?: string }>),
    enabled: !!target && target !== owned.regionId,
  });
  const send = useMutation({
    mutationFn: () => api.sendArmy(matchId, owned.regionId, { mission, targetRegionId: target!, units: chosen, people: mission === "conquer" ? 0 : people, cargo }),
    onSuccess: () => {
      setUnits({});
      setPeople(0);
      setCargo({});
      // The target is cleared so a second army is never sent to the same region by accident.
      onClearTarget();
      void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
    },
  });
  const targetRegion = target ? regionById(target) : null;
  const settlers = chosen.settler ?? 0;
  const settlersHome = owned.units.settler ?? 0;
  const settleOk = mission !== "settle" || (settlers >= balance.settle.settlersRequired && Object.keys(chosen).every((id) => id === "settler"));
  const conquerOk = mission !== "conquer" || (settlers >= balance.conquest.occupiersRequired && Object.keys(chosen).some((id) => id !== "settler"));
  const canSend = !!target && target !== owned.regionId && Object.keys(chosen).length > 0 && settleOk && conquerOk;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-1">
        {MISSIONS.map((m) => (
          <button
            key={m.id}
            onClick={() => setMission(m.id)}
            title={m.hint}
            className={`rounded px-2 py-1 text-xs ${mission === m.id ? "bg-sky-500 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-400">{MISSIONS.find((m) => m.id === mission)?.hint}</p>

      <div className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1.5">
        <span className={targetRegion ? "text-slate-100" : "text-slate-500"}>{targetRegion ? `${targetRegion.name} (${targetRegion.countryName})` : "No target"}</span>
        <Button variant="ghost" onClick={() => setPicking((p) => !p)}>
          {picking ? "Click the map..." : "Pick target"}
        </Button>
      </div>
      {route.data?.seconds !== undefined && (
        <p className="text-xs text-slate-400">
          Travel: {formatCountdown(route.data.seconds)} · {route.data.path!.length - 1} legs{route.data.usesSea ? " · by sea" : ""}
        </p>
      )}
      {route.data?.error && <p className="text-xs text-rose-400">{route.data.error}</p>}
      {mission === "settle" && (
        <p className="text-xs text-slate-400">
          Needs {balance.settle.settlersRequired} settlers and an empty region (unclaimed regions next to yours are outlined on the map).{settlers > 0 && settlers < balance.settle.settlersRequired ? ` You selected ${settlers}.` : ""}
        </p>
      )}

      {available.length === 0 ? (
        <p className="text-slate-400">No units here. Train some first.</p>
      ) : (
        <ul className="space-y-1">
          {available.map(([id, n]) => (
            <li key={id} className="grid grid-cols-[1fr_6rem_3rem] items-center gap-2">
              <span>{unitById.get(id)?.name ?? id}</span>
              <input
                type="range"
                min={0}
                max={n}
                value={units[id] ?? 0}
                onChange={(e) => setUnits((u) => ({ ...u, [id]: Number(e.target.value) }))}
                className="accent-sky-500"
              />
              <button className="text-right tabular-nums text-slate-300 hover:text-white" onClick={() => setUnits((u) => ({ ...u, [id]: u[id] === n ? 0 : n }))} title="All / none">
                {units[id] ?? 0}/{n}
              </button>
            </li>
          ))}
        </ul>
      )}

      {(mission === "move" || mission === "reinforce") && (
        <label className="flex items-center gap-2">
          <span className="w-24 text-slate-400">People</span>
          <input type="number" min={0} max={Math.floor(owned.popWorkers)} value={people} onChange={(e) => setPeople(Math.max(0, Number(e.target.value)))} className="w-24 rounded border border-slate-700 bg-slate-900 px-2 py-1" />
        </label>
      )}
      {mission === "conquer" && (
        <p className={`text-xs ${settlersHome < balance.conquest.occupiersRequired ? "text-amber-300" : settlers < balance.conquest.occupiersRequired ? "text-slate-400" : "text-emerald-400"}`}>
          {settlersHome < balance.conquest.occupiersRequired
            ? `Conquest needs at least ${balance.conquest.occupiersRequired} Settlers ready here to occupy the region; you have ${settlersHome}. Train them under the Train tab.`
            : settlers < balance.conquest.occupiersRequired
              ? `Add at least ${balance.conquest.occupiersRequired} Settlers to the army; they stay out of the fight and become the occupiers.`
              : `${settlers} settlers will occupy the region if the attack succeeds.`}
        </p>
      )}
      {mission === "transport" && (
        <div className="space-y-1">
          {(["food", "wood", "stone", "copper", "tin", "iron", "horses"] as const).map((k) => {
            const have = k === "food" || k === "wood" || k === "stone" ? owned[k] : owned.special[k];
            if (have < 1) return null;
            return (
              <label key={k} className="flex items-center gap-2">
                <span className="w-24 capitalize text-slate-400">{k}</span>
                <input type="number" min={0} max={Math.floor(have)} value={cargo[k] ?? 0} onChange={(e) => setCargo((c) => ({ ...c, [k]: Math.max(0, Number(e.target.value)) }))} className="w-24 rounded border border-slate-700 bg-slate-900 px-2 py-1" />
                <span className="text-xs text-slate-500">of {fmt(have)}</span>
              </label>
            );
          })}
        </div>
      )}
      <Button disabled={!canSend || send.isPending} onClick={() => send.mutate()}>
        Send
      </Button>
      <ErrorText>{send.error?.message}</ErrorText>
      <ArmiesList state={state} clockOffsetMs={clockOffsetMs} />
    </div>
  );
}

export function ArmiesList({ state, clockOffsetMs }: { state: MatchStateView; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const recall = useMutation({ mutationFn: (armyId: string) => api.recallArmy(state.match.id, armyId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(state.match.id) }) });
  if (state.armies.length === 0) return null;
  return (
    <div className="border-t border-slate-800 pt-2">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Units on the move</h3>
      <ul className="space-y-1 text-sm">
        {state.armies.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <span>
              <span>{missionLabel(a.mission)}</span> {a.status === "returning" ? "returning to" : "→"} {regionById(a.status === "returning" ? a.originRegionId : a.targetRegionId)?.name}
              {a.status === "returning" && a.note ? <span className="text-slate-500"> ({a.note})</span> : null}
              <span className="ml-1 text-xs text-slate-500">({Object.values(a.units).reduce((x, y) => x + y, 0)} units)</span>
            </span>
            <span className="text-slate-400">
              <Countdown to={a.status === "returning" ? (a.returnsAt ?? a.arrivesAt) : a.arrivesAt} clockOffsetMs={clockOffsetMs} />
            </span>
            {a.status === "outbound" && (
              <button className="text-xs text-slate-500 hover:text-amber-300" onClick={() => recall.mutate(a.id)} title="Recall: turn around and come home">
                Recall
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Red banner with countdowns for hostile armies heading our way. */
export function IncomingWarnings({ state, clockOffsetMs, onSelect }: { state: MatchStateView; clockOffsetMs: number; onSelect: (regionId: string) => void }) {
  const list = useMemo(() => [...state.incoming].sort((a, b) => Date.parse(a.arrivesAt) - Date.parse(b.arrivesAt)), [state.incoming]);
  if (list.length === 0) return null;
  return (
    <Card className="border-rose-500/50 bg-rose-500/10">
      <h2 className="mb-1 text-sm font-medium text-rose-200">Incoming attacks</h2>
      <ul className="space-y-1 text-sm">
        {list.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2">
            <button className="text-left text-rose-100 hover:underline" onClick={() => onSelect(i.targetRegionId)}>
              {i.fromPlayerName} {i.mission === "raid" ? "raiding" : "attacking"} {regionById(i.targetRegionId)?.name} (~{i.size} units)
            </button>
            <span className="tabular-nums text-rose-200">
              <Countdown to={i.arrivesAt} clockOffsetMs={clockOffsetMs} prefix="in " />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
