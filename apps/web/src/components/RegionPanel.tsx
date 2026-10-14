import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  AGES,
  availableBuildings,
  availableUnits,
  balance,
  buildingById,
  buildingCost,
  buildingSeconds,
  canAfford,
  computeRates,
  normalizeAssignment,
  realSeconds,
  regionById,
  settle,
  totalPopulation,
  trainSeconds,
  unitById,
  unitCost,
  formatCountdown,
  type MatchStateView,
  type OwnedRegionView,
  type RegionEconomy,
  type SightedRegionView,
  type SpecialResource,
} from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { useNow } from "../hooks/useNow.js";
import { Button, Card, ErrorText, fmt, signed } from "./ui.js";
import { Countdown, costText } from "./Countdown.js";
import { SendArmy } from "./ArmyPanel.js";

interface Props {
  matchId: string;
  state: MatchStateView;
  regionId: string;
  /** Offset to add to local time to get match time, in ms. */
  clockOffsetMs: number;
  onClose: () => void;
  /** Army target picked on the map, and a way to enter picking mode. */
  target: string | null;
  onPickTarget: (picking: boolean) => void;
}

type Tab = "overview" | "build" | "train" | "army";

export function RegionPanel({ matchId, state, regionId, clockOffsetMs, onClose, target, onPickTarget }: Props) {
  const region = regionById(regionId);
  const owned = state.owned.find((o) => o.regionId === regionId) ?? null;
  const sighted = state.sighted.find((s) => s.regionId === regionId) ?? null;
  const [tab, setTab] = useState<Tab>("overview");
  useEffect(() => setTab("overview"), [regionId]);
  if (!region) return null;

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold leading-tight">{region.name}</h2>
          <p className="text-xs text-slate-400">
            {region.countryName} · {region.terrain}
            {region.coastal ? " · coastal" : ""}
            {region.river ? " · river" : ""}
          </p>
        </div>
        <button className="text-slate-400 hover:text-white" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <p className="text-sm text-slate-300">
        Resources: <span className="text-slate-100">{region.resources.map((r) => r.replace("_", " ")).join(", ")}</span>
      </p>
      {owned ? (
        <>
          <nav className="flex gap-1 border-b border-slate-800 text-sm">
            {(["overview", "build", "train", "army"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 capitalize ${tab === t ? "border-b-2 border-sky-400 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                {t}
              </button>
            ))}
          </nav>
          {tab === "overview" && <OwnedDetails matchId={matchId} owned={owned} clockOffsetMs={clockOffsetMs} speed={state.match.speed} />}
          {tab === "build" && <BuildTab matchId={matchId} state={state} owned={owned} clockOffsetMs={clockOffsetMs} />}
          {tab === "train" && <TrainTab matchId={matchId} state={state} owned={owned} clockOffsetMs={clockOffsetMs} />}
          {tab === "army" && (
            <>
              <ArmyTab owned={owned} />
              <SendArmy matchId={matchId} state={state} owned={owned} target={target} onPickTarget={onPickTarget} clockOffsetMs={clockOffsetMs} />
            </>
          )}
          <QueueList matchId={matchId} state={state} regionId={regionId} clockOffsetMs={clockOffsetMs} />
        </>
      ) : sighted ? (
        <SightedDetails s={sighted} />
      ) : (
        <p className="text-sm text-slate-400">You have no recent information about this region. Send a scout to learn more.</p>
      )}
    </Card>
  );
}

function SightedDetails({ s }: { s: SightedRegionView }) {
  return (
    <div className="text-sm text-slate-300">
      <p>Owner: {s.ownerName ?? "nobody"}</p>
      <p>Population: {s.population === null ? "unknown" : fmt(s.population)}</p>
      <p className="text-xs text-slate-500">Seen {new Date(s.seenAt).toLocaleString()}</p>
    </div>
  );
}

/** Project the server snapshot forward with the same pure settle the server uses. */
export function useLiveEconomy(owned: OwnedRegionView, clockOffsetMs: number, speed: number) {
  const now = useNow(1000);
  return useMemo(() => {
    const region = regionById(owned.regionId)!;
    const traits = { terrain: region.terrain, resources: region.resources, coastal: region.coastal, river: region.river };
    const base: RegionEconomy = {
      popWorkers: owned.popWorkers,
      popSoldiers: owned.popSoldiers,
      popOccupiers: owned.popOccupiers,
      food: owned.food,
      wood: owned.wood,
      stone: owned.stone,
      special: owned.special,
      assignment: owned.assignment,
      storage: owned.storage,
      capacity: owned.capacity,
      yieldMult: owned.yieldMult,
      extract: owned.extract as Partial<Record<SpecialResource, number>>,
      frozen: owned.frozen,
    };
    const elapsed = Math.max(0, (now + clockOffsetMs - Date.parse(owned.asOf)) / 1000);
    const e = settle(traits, base, elapsed, speed);
    return { e, rates: computeRates(traits, e) };
  }, [owned, now, clockOffsetMs, speed]);
}

function OwnedDetails({ matchId, owned, clockOffsetMs, speed }: { matchId: string; owned: OwnedRegionView; clockOffsetMs: number; speed: number }) {
  const live = useLiveEconomy(owned, clockOffsetMs, speed);
  const pop = totalPopulation(live.e);
  const perHour = (v: number) => signed(v * speed, 1);
  const specials = Object.entries(live.e.special).filter(([, v]) => v > 0.5 || Object.keys(owned.extract).length);

  return (
    <div className="space-y-3">
      {owned.isCapital && <span className="inline-block rounded bg-sky-500/20 px-1.5 py-0.5 text-xs text-sky-300">Capital</span>}
      {owned.frozen && <span className="ml-2 inline-block rounded bg-cyan-200/20 px-1.5 py-0.5 text-xs text-cyan-200">Frozen</span>}
      <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-sm">
        <Row label="People" value={`${fmt(pop)} / ${fmt(live.e.capacity)}`} rate={perHour(live.rates.population)} />
        <Row label="Food" value={`${fmt(live.e.food)} / ${fmt(live.e.storage.food)}`} rate={perHour(live.rates.food)} warn={live.rates.starving} />
        <Row label="Wood" value={`${fmt(live.e.wood)} / ${fmt(live.e.storage.wood)}`} rate={perHour(live.rates.wood)} />
        <Row label="Stone" value={`${fmt(live.e.stone)} / ${fmt(live.e.storage.stone)}`} rate={perHour(live.rates.stone)} />
        {specials.map(([k, v]) => (
          <Row key={k} label={k[0]!.toUpperCase() + k.slice(1)} value={fmt(v)} rate={perHour(live.rates.special[k as SpecialResource] ?? 0)} />
        ))}
      </dl>
      <p className="text-xs text-slate-500">
        Workers {fmt(live.e.popWorkers)} · soldiers {fmt(live.e.popSoldiers)} · occupiers {fmt(live.e.popOccupiers)}. Rates per real hour at {speed}x.
      </p>
      {live.rates.starving && <p className="text-sm text-rose-400">Your people are starving. Assign more workers to food.</p>}
      <AssignmentEditor matchId={matchId} owned={owned} workers={live.e.popWorkers} />
      {Object.keys(owned.buildings).length > 0 && (
        <p className="text-xs text-slate-400">
          Buildings:{" "}
          {Object.entries(owned.buildings)
            .map(([id, lvl]) => `${buildingById.get(id)?.name ?? id} ${lvl}`)
            .join(", ")}
        </p>
      )}
    </div>
  );
}

function Row({ label, value, rate, warn }: { label: string; value: string; rate: string; warn?: boolean }) {
  return (
    <>
      <dt className="text-slate-400">{label}</dt>
      <dd className="tabular-nums text-slate-100">{value}</dd>
      <dd className={`tabular-nums text-right ${warn ? "text-rose-400" : rate.startsWith("+") ? "text-emerald-400" : "text-slate-400"}`}>{rate}/h</dd>
    </>
  );
}

function AssignmentEditor({ matchId, owned, workers }: { matchId: string; owned: OwnedRegionView; workers: number }) {
  const qc = useQueryClient();
  const [shares, setShares] = useState(owned.assignment);
  useEffect(() => setShares(owned.assignment), [owned.assignment]);
  const m = useMutation({
    mutationFn: () => api.assign(matchId, owned.regionId, shares),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  const norm = normalizeAssignment(shares);
  const dirty = ["food", "wood", "stone"].some((k) => Math.abs((norm as Record<string, number>)[k]! - (owned.assignment as Record<string, number>)[k]!) > 0.005);
  const set = (key: "food" | "wood" | "stone", v: number) => setShares((s) => ({ ...s, [key]: v }));

  return (
    <div className="space-y-2 border-t border-slate-800 pt-3">
      <h3 className="text-sm font-medium">Workers ({fmt(workers)})</h3>
      {(["food", "wood", "stone"] as const).map((k) => (
        <label key={k} className="grid grid-cols-[4rem_1fr_3rem] items-center gap-2 text-sm">
          <span className="capitalize text-slate-300">{k}</span>
          <input type="range" min={0} max={100} value={Math.round(shares[k] * 100)} onChange={(e) => set(k, Number(e.target.value) / 100)} className="accent-sky-500" />
          <span className="text-right tabular-nums text-slate-400">{Math.round(norm[k] * 100)}%</span>
        </label>
      ))}
      <div className="flex items-center gap-2">
        <Button onClick={() => m.mutate()} disabled={!dirty || m.isPending}>
          Apply
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setShares(owned.assignment)}>
            Reset
          </Button>
        )}
      </div>
      <ErrorText>{m.error?.message}</ErrorText>
    </div>
  );
}

function stockOf(e: RegionEconomy): Record<string, number> {
  return { food: e.food, wood: e.wood, stone: e.stone, ...e.special };
}

function BuildTab({ matchId, state, owned, clockOffsetMs }: { matchId: string; state: MatchStateView; owned: OwnedRegionView; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const live = useLiveEconomy(owned, clockOffsetMs, state.match.speed);
  const techs = useMemo(() => new Set(state.me.techs), [state.me.techs]);
  const pendingHere = state.jobs.filter((j) => j.regionId === owned.regionId);
  const queueFull = pendingHere.length >= balance.queue.slotsPerRegion;
  const m = useMutation({
    mutationFn: (buildingId: string) => api.build(matchId, owned.regionId, buildingId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  const stock = stockOf(live.e);
  const list = availableBuildings(state.me.age, techs);
  return (
    <div className="space-y-2">
      {queueFull && <p className="text-xs text-amber-300">Queue full ({balance.queue.slotsPerRegion} slots).</p>}
      <ErrorText>{m.error?.message}</ErrorText>
      <ul className="divide-y divide-slate-800">
        {list.map((b) => {
          const queued = pendingHere.filter((j) => j.kind === "build" && j.refId === b.id).length;
          const level = (owned.buildings[b.id] ?? 0) + queued + 1;
          const maxed = level > b.maxLevel;
          const cost = buildingCost(b, level);
          const ok = !maxed && !queueFull && canAfford(stock, cost);
          const secs = realSeconds(buildingSeconds(b, level), 0, state.match.speed);
          return (
            <li key={b.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{b.name}</span>
                  <span className="text-xs text-slate-500">
                    lvl {owned.buildings[b.id] ?? 0}
                    {queued ? ` (+${queued})` : ""}
                  </span>
                </div>
                <p className="truncate text-xs text-slate-400">{b.description}</p>
                {!maxed && (
                  <p className={`text-xs ${canAfford(stock, cost) ? "text-slate-400" : "text-rose-400"}`}>
                    {costText(cost)} · {formatCountdown(secs)}
                  </p>
                )}
              </div>
              <Button variant="ghost" disabled={!ok || m.isPending} onClick={() => m.mutate(b.id)}>
                {maxed ? "Max" : `Lvl ${level}`}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TrainTab({ matchId, state, owned, clockOffsetMs }: { matchId: string; state: MatchStateView; owned: OwnedRegionView; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const live = useLiveEconomy(owned, clockOffsetMs, state.match.speed);
  const techs = useMemo(() => new Set(state.me.techs), [state.me.techs]);
  const region = regionById(owned.regionId)!;
  const [qty, setQty] = useState(5);
  const pendingHere = state.jobs.filter((j) => j.regionId === owned.regionId);
  const queueFull = pendingHere.length >= balance.queue.slotsPerRegion;
  const m = useMutation({
    mutationFn: (unitId: string) => api.train(matchId, owned.regionId, unitId, qty),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  const stock = stockOf(live.e);
  const list = availableUnits(state.me.age, techs);
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-slate-400">Batch size</span>
        <input type="number" min={1} max={1000} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1" />
        <span className="text-xs text-slate-500">free workers {fmt(live.e.popWorkers)}</span>
      </label>
      {queueFull && <p className="text-xs text-amber-300">Queue full.</p>}
      <ErrorText>{m.error?.message}</ErrorText>
      <ul className="divide-y divide-slate-800">
        {list.map((u) => {
          const cost = unitCost(u, qty);
          const needs = u.needsResource && !region.resources.includes(u.needsResource);
          const ok = !queueFull && !needs && canAfford(stock, cost) && live.e.popWorkers >= qty;
          const secs = realSeconds(trainSeconds(u, qty), owned.effects.trainSpeed, state.match.speed);
          return (
            <li key={u.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{u.name}</span>
                  <span className="text-xs text-slate-500">
                    atk {u.attack} · def {u.defense} · spd {u.speed}
                  </span>
                </div>
                <p className={`text-xs ${needs ? "text-rose-400" : canAfford(stock, cost) ? "text-slate-400" : "text-rose-400"}`}>
                  {needs ? `needs ${u.needsResource} here` : `${costText(cost)} · ${formatCountdown(secs)}`}
                </p>
              </div>
              <Button variant="ghost" disabled={!ok || m.isPending} onClick={() => m.mutate(u.id)}>
                Train {qty}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ArmyTab({ owned }: { owned: OwnedRegionView }) {
  const entries = Object.entries(owned.units).filter(([, n]) => n > 0);
  return (
    <div className="space-y-2 text-sm">
      {entries.length === 0 ? (
        <p className="text-slate-400">No units stationed here. Train some under the Train tab.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map(([id, n]) => (
            <li key={id} className="flex justify-between">
              <span>{unitById.get(id)?.name ?? id}</span>
              <span className="tabular-nums text-slate-300">{n}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">Defence bonus from buildings: +{Math.round(owned.effects.defense * 100)}%</p>
    </div>
  );
}

function QueueList({ matchId, state, regionId, clockOffsetMs }: { matchId: string; state: MatchStateView; regionId: string; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const jobsHere = state.jobs.filter((j) => j.regionId === regionId);
  const cancel = useMutation({ mutationFn: (jobId: string) => api.cancelJob(matchId, jobId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  if (jobsHere.length === 0) return null;
  return (
    <div className="border-t border-slate-800 pt-2">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
        Queue ({jobsHere.length}/{balance.queue.slotsPerRegion})
      </h3>
      <ul className="space-y-1 text-sm">
        {jobsHere.map((j) => (
          <li key={j.id} className="flex items-center justify-between gap-2">
            <span>
              {j.kind === "build" ? `${buildingById.get(j.refId ?? "")?.name ?? j.refId} lvl ${j.level}` : `${j.qty} ${unitById.get(j.refId ?? "")?.name ?? j.refId}`}
            </span>
            <span className="text-slate-400">
              <Countdown to={j.endsAt} clockOffsetMs={clockOffsetMs} />
            </span>
            <button className="text-xs text-slate-500 hover:text-rose-400" onClick={() => cancel.mutate(j.id)} title="Cancel">
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ageName(age: number): string {
  return AGES[age as 0 | 1 | 2 | 3 | 4] ?? "Unknown";
}
