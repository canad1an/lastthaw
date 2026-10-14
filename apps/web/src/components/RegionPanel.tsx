import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AGES, availableBuildings, availableUnits, buildingBlockedBy, balance, buildingById, buildingCost, matchDayOf, buildingSeconds, canAfford, computeRates, normalizeAssignment, realSeconds, regionById, settle, totalPopulation, trainSeconds, unitById, unitCost, formatCountdown, type MatchStateView, type OwnedRegionView, type RegionEconomy, type SightedRegionView, type SpecialResource, loyaltyBand, loyaltyOutlook, HAULER_IDS, haulerCarry } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { useNow } from "../hooks/useNow.js";
import { Button, Card, ErrorText, fmt, signed } from "./ui.js";
import { Countdown, CostLine } from "./Countdown.js";
import { SendArmy } from "./ArmyPanel.js";
import { ColonizePanel } from "./ColonizePanel.js";
import { EvacuatePanel } from "./EvacuatePanel.js";
import { BeforeAfter, Tooltip } from "./Tooltip.js";
import { buildingPreview, unitPreview } from "./previews.js";
import type { BuildingDef, UnitDef } from "@lastthaw/shared";

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
  /** Forget the picked target (after a send, so the next army needs a fresh pick). */
  onClearTarget: () => void;
}

type Tab = "overview" | "build" | "train" | "units";

export function RegionPanel({ matchId, state, regionId, clockOffsetMs, onClose, target, onPickTarget, onClearTarget }: Props) {
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
            {(["overview", "build", "train", "units"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 capitalize ${tab === t ? "border-b-2 border-sky-400 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                {t}
              </button>
            ))}
          </nav>
          {tab === "overview" && (
            <>
              <OwnedDetails matchId={matchId} state={state} owned={owned} clockOffsetMs={clockOffsetMs} speed={state.match.speed} />
              <EvacuatePanel matchId={matchId} state={state} owned={owned} matchDay={Math.max(0, ((Date.now() + clockOffsetMs - Date.parse(state.match.startsAt)) / 86400_000) * state.match.speed)} />
            </>
          )}
          {tab === "build" && <BuildTab matchId={matchId} state={state} owned={owned} clockOffsetMs={clockOffsetMs} />}
          {tab === "train" && <TrainTab matchId={matchId} state={state} owned={owned} clockOffsetMs={clockOffsetMs} />}
          {tab === "units" && (
            <>
              <ArmyTab matchId={matchId} owned={owned} state={state} />
              <SendArmy matchId={matchId} state={state} owned={owned} target={target} onPickTarget={onPickTarget} onClearTarget={onClearTarget} clockOffsetMs={clockOffsetMs} />
            </>
          )}
          <QueueList matchId={matchId} state={state} regionId={regionId} clockOffsetMs={clockOffsetMs} />
        </>
      ) : state.frontier.includes(regionId) ? (
        <ColonizePanel matchId={matchId} state={state} regionId={regionId} />
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
      iceFactor: owned.iceFactor,
      growthMult: owned.growthMult,
      frozen: owned.frozen,
    };
    const elapsed = Math.max(0, (now + clockOffsetMs - Date.parse(owned.asOf)) / 1000);
    const e = settle(traits, base, elapsed, speed);
    return { e, rates: computeRates(traits, e) };
  }, [owned, now, clockOffsetMs, speed]);
}

function OwnedDetails({ matchId, state, owned, clockOffsetMs, speed }: { matchId: string; state: MatchStateView; owned: OwnedRegionView; clockOffsetMs: number; speed: number }) {
  const live = useLiveEconomy(owned, clockOffsetMs, speed);
  const pop = totalPopulation(live.e);
  const perHour = (v: number) => signed(v * speed, 1);
  const specials = Object.entries(live.e.special).filter(([, v]) => v > 0.5 || Object.keys(owned.extract).length);

  return (
    <div className="space-y-3">
      {owned.isCapital && <span className="inline-block rounded bg-sky-500/20 px-1.5 py-0.5 text-xs text-sky-300">Capital</span>}
      {owned.frozen && <span className="ml-2 inline-block rounded bg-cyan-200/20 px-1.5 py-0.5 text-xs text-cyan-200">Frozen</span>}
      {!owned.isCapital && !owned.frozen && <MakeCapital matchId={matchId} state={state} regionId={owned.regionId} clockOffsetMs={clockOffsetMs} />}
      <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-sm">
        <Row label="People" value={`${fmt(pop)} / ${fmt(live.e.capacity)}`} rate={perHour(live.rates.population)} />
        {!owned.isCapital && <LoyaltyRow owned={owned} state={state} />}
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

/** Loyalty now, where it is heading, and why; hover for the breakdown. */
function LoyaltyRow({ owned, state }: { owned: OwnedRegionView; state: MatchStateView }) {
  const pop = owned.popWorkers + owned.popSoldiers + owned.popOccupiers;
  const o = loyaltyOutlook(owned.regionId, state.me.capitalRegionId, owned.effects.loyalty, pop, owned.popOccupiers, owned.loyalty, owned.conquered);
  const templeLevel = owned.buildings.temple ?? 0;
  const band = loyaltyBand(owned.loyalty);
  const tone = band === "rebellious" ? "text-rose-400" : band === "uneasy" ? "text-amber-300" : "text-emerald-400";
  const arrow = o.target > owned.loyalty + 0.01 ? "↑" : o.target < owned.loyalty - 0.01 ? "↓" : "→";
  return (
    <>
      <dt className="text-slate-400">Loyalty</dt>
      <dd className={`tabular-nums ${tone}`}>
        <Tooltip
          className="cursor-help"
          trigger={
            <span>
              {Math.round(owned.loyalty * 100)}% {arrow} {Math.round(o.target * 100)}%
            </span>
          }
        >
          <div className="space-y-1 text-xs">
            <p className="font-medium text-slate-100">
              {band === "rebellious" ? "At risk: may rebel any tick" : band === "uneasy" ? "Uneasy" : "Secure"} · heading to {Math.round(o.target * 100)}%
              {o.hoursToSettle > 1 ? ` in about ${Math.round(o.hoursToSettle)} game hours` : ""}
            </p>
            <p className="text-slate-300">Distance from capital: {Math.round(o.km)} km, −{Math.round(o.distancePenalty * 100)}%</p>
            <p className="text-slate-300">Roads, temples, forts: +{Math.round(o.buildingBonus * 100)}%</p>
            {owned.conquered ? (
              <p className="text-slate-300">
                Occupiers: {Math.round(owned.popOccupiers)} of {Math.ceil(o.occupiersNeeded)} needed ({o.occupierFactor >= 1 ? "no penalty" : `target cut by ${Math.round((1 - o.occupierFactor) * 50)}%`})
                {templeLevel > 0
                  ? `; the Temple converts ${balance.conquest.templeConvertsPerHour} workers an hour into occupiers`
                  : "; a Temple would convert workers into occupiers over time"}
              </p>
            ) : (
              <p className="text-slate-300">Settled by your own people: no occupiers needed.</p>
            )}
            <p className="text-slate-500">Below {Math.round(o.rebelBelow * 100)}% the region can rebel: it goes neutral and your occupiers are lost.</p>
          </div>
        </Tooltip>
      </dd>
      <dd className="text-right text-xs text-slate-500">{band === "secure" ? "secure" : band === "uneasy" ? "uneasy" : "rebellious"}</dd>
    </>
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
  /** Move one slider; the other two give up or take the difference in proportion to their current shares. */
  const set = (key: "food" | "wood" | "stone", v: number) =>
    setShares((s) => {
      const value = Math.min(1, Math.max(0, v));
      const others = (["food", "wood", "stone"] as const).filter((k) => k !== key);
      const rest = others.reduce((a, k) => a + s[k], 0);
      const remaining = 1 - value;
      const next = { ...s, [key]: value };
      for (const k of others) next[k] = rest > 0 ? (s[k] / rest) * remaining : remaining / others.length;
      return next;
    });

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
  // Buildings draw on the capital's treasury too, so affordability counts both.
  // Buildings draw on every region: this one first, then the capital, then the rest.
  const here = stockOf(live.e);
  const stock: Record<string, number> = { ...here };
  const elsewhere: Record<string, number> = {};
  for (const o of state.owned) {
    if (o.regionId === owned.regionId || o.frozen) continue;
    for (const [k, v] of Object.entries({ food: o.food, wood: o.wood, stone: o.stone, ...o.special })) {
      stock[k] = (stock[k] ?? 0) + v;
      elsewhere[k] = (elsewhere[k] ?? 0) + v;
    }
  }
  const fromElsewhere = (cost: Record<string, number | undefined>) =>
    Object.entries(cost)
      .filter(([k, v]) => (v ?? 0) > (here[k] ?? 0) && (stock[k] ?? 0) >= (v ?? 0))
      .map(([k, v]) => `${fmt((v ?? 0) - (here[k] ?? 0))} ${k}`);
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
          const cost = buildingCost(b, level, matchDayOf(state, clockOffsetMs), regionById(owned.regionId)?.neighbors.length ?? 1);
          const blocked = buildingBlockedBy(b, regionById(owned.regionId)!, owned.buildings);
          const ok = !maxed && !queueFull && !blocked && canAfford(stock, cost);
          const secs = realSeconds(buildingSeconds(b, level), 0, state.match.speed);
          return (
            <li key={b.id} className={`flex items-center justify-between gap-2 py-2 text-sm ${blocked ? "opacity-60" : ""}`}>
              <Tooltip
                className="min-w-0 flex-1 cursor-help"
                trigger={
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{b.name}</span>
                      {blocked && <span className="rounded bg-rose-500/20 px-1 text-xs text-rose-300">not here</span>}
                      <span className="text-xs text-slate-500">
                        lvl {owned.buildings[b.id] ?? 0}
                        {queued ? ` (+${queued})` : ""}
                      </span>
                      <span className="text-xs text-slate-600">ⓘ</span>
                    </div>
                    <p className="truncate text-xs text-slate-400">{b.description}</p>
                    {!maxed && (
                      <p>
                        <CostLine cost={cost} stock={stock} suffix={formatCountdown(secs)} />
                        {fromElsewhere(cost).length > 0 && <span className="ml-1 text-xs text-sky-300">({fromElsewhere(cost).join(", ")} will come by caravan from {owned.isCapital ? "other regions" : "the capital or other regions"}; the build starts when it arrives)</span>}
                      </p>
                    )}
                  </div>
                }
              >
                {blocked ? <p className="text-rose-300">{blocked}</p> : <BuildingTip def={b} level={Math.min(level, b.maxLevel)} owned={owned} economy={live.e} speed={state.match.speed} maxed={maxed} />}
              </Tooltip>
              <Button variant="ghost" disabled={!ok || m.isPending} onClick={() => m.mutate(b.id)}>
                {maxed ? "Max" : blocked ? "—" : `Lvl ${level}`}
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
    mutationFn: ({ unitId, n }: { unitId: string; n: number }) => api.train(matchId, owned.regionId, unitId, n),
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
          const n = Math.max(qty, u.minBatch ?? 1);
          const cost = unitCost(u, n, matchDayOf(state, clockOffsetMs));
          const needs = u.needsResource && !region.resources.includes(u.needsResource);
          const ok = !queueFull && !needs && canAfford(stock, cost) && live.e.popWorkers >= n;
          const secs = realSeconds(trainSeconds(u, n), owned.effects.trainSpeed, state.match.speed);
          return (
            <li key={u.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <Tooltip
                className="min-w-0 flex-1 cursor-help"
                trigger={
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{u.name}</span>
                      <span className="text-xs text-slate-500">
                        atk {u.attack} · def {u.defense} · spd {u.speed}
                      </span>
                      <span className="text-xs text-slate-600">ⓘ</span>
                    </div>
                    {needs ? <p className="text-xs text-rose-400">needs {u.needsResource} here</p> : <p><CostLine cost={cost} stock={stock} suffix={formatCountdown(secs)} /></p>}
                    {u.minBatch && <p className="text-xs text-slate-500">trained in groups of at least {u.minBatch}</p>}
                  </div>
                }
              >
                {needs ? (
                  <p className="text-rose-300">
                    {u.name} needs {u.needsResource} in the region. {region.name} has {region.resources.map((r) => r.replace("_", " ")).join(", ")}.
                  </p>
                ) : (
                  <UnitTip def={u} qty={qty} workers={live.e.popWorkers} soldiers={live.e.popSoldiers} />
                )}
              </Tooltip>
              <Button variant="ghost" disabled={!ok || m.isPending} onClick={() => m.mutate({ unitId: u.id, n })}>
                Train {n}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ArmyTab({ matchId, owned, state }: { matchId: string; owned: OwnedRegionView; state: MatchStateView }) {
  const qc = useQueryClient();
  const entries = Object.entries(owned.units).filter(([, n]) => n > 0);
  const convert = useMutation({
    mutationFn: (body: { from: string; to: string; qty: number }) => api.convert(matchId, owned.regionId, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  const [disbanding, setDisbanding] = useState<Record<string, number>>({});
  const disband = useMutation({
    mutationFn: () => api.disband(matchId, owned.regionId, disbanding),
    onSuccess: () => {
      setDisbanding({});
      void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
    },
  });
  const total = Object.values(disbanding).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-2 text-sm">
      {entries.length === 0 ? (
        <p className="text-slate-400">No units stationed here. Train some under the Train tab.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map(([id, n]) => (
            <li key={id} className="flex items-center justify-between gap-2">
              <span>{unitById.get(id)?.name ?? id}</span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-slate-300">{n}</span>
                <input
                  type="number"
                  min={0}
                  max={n}
                  value={disbanding[id] ?? 0}
                  onChange={(e) => setDisbanding((d) => ({ ...d, [id]: Math.max(0, Math.min(n, Number(e.target.value) || 0)) }))}
                  className="w-16 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-right"
                  aria-label={`Disband ${unitById.get(id)?.name ?? id}`}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">Defence bonus from buildings: +{Math.round(owned.effects.defense * 100)}%</p>
      <HaulerUpgrades owned={owned} techs={state.me.techs} age={state.me.age} onConvert={(body) => convert.mutate(body)} pending={convert.isPending} />
      <ErrorText>{convert.error?.message}</ErrorText>
      {entries.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-t border-slate-800 pt-2">
          <span className="text-xs text-slate-400">
            Stationed units defend and eat {balance.economy.soldierFoodMultiplier}x a worker's food. Disbanded units rejoin the workers; nothing is refunded.
          </span>
          <Button variant="ghost" disabled={total === 0 || disband.isPending} onClick={() => disband.mutate()}>
            Disband {total > 0 ? total : ""}
          </Button>
        </div>
      )}
      <ErrorText>{disband.error?.message}</ErrorText>
    </div>
  );
}

/** Upgrade buttons for haulers stationed here, when the tech for the better kind is known. */
function HaulerUpgrades({ owned, techs, age, onConvert, pending }: { owned: OwnedRegionView; techs: readonly string[]; age: number; onConvert: (body: { from: string; to: string; qty: number }) => void; pending: boolean }) {
  const options: Array<{ from: string; to: string; have: number; cost: Record<string, number> }> = [];
  for (const to of HAULER_IDS) {
    const dst = unitById.get(to);
    if (!dst || dst.age > age || (dst.requires && !techs.includes(dst.requires))) continue;
    const per = balance.trade.convertCost[to];
    if (!per) continue;
    for (const from of HAULER_IDS) {
      const src = unitById.get(from);
      if (!src || src.carry >= dst.carry) continue;
      const have = owned.units[from] ?? 0;
      if (have > 0) options.push({ from, to, have, cost: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v * have])) });
    }
  }
  if (options.length === 0) return null;
  return (
    <div className="space-y-1 border-t border-slate-800 pt-2">
      {options.map((o) => (
        <div key={`${o.from}-${o.to}`} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-slate-300">
            Upgrade {o.have} {unitById.get(o.from)?.name}{o.have === 1 ? "" : "s"} → {unitById.get(o.to)?.name}{o.have === 1 ? "" : "s"}{" "}
            <span className="text-slate-500">({Object.entries(o.cost).map(([k, v]) => `${fmt(v)} ${k}`).join(", ")}; carries {fmt(haulerCarry(o.to, techs))} each)</span>
          </span>
          <Button variant="ghost" disabled={pending} onClick={() => onConvert({ from: o.from, to: o.to, qty: o.have })}>
            Upgrade
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Move the capital here: a capital wagon sets out from the old capital with its stores; the capital changes on arrival. */
function MakeCapital({ matchId, state, regionId, clockOffsetMs }: { matchId: string; state: MatchStateView; regionId: string; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const capital = state.me.capitalRegionId;
  const wagon = state.armies.find((a) => a.mission === "relocate" && a.status === "outbound");
  const route = useQuery({
    queryKey: ["route", matchId, capital, regionId, "wagon"],
    queryFn: () =>
      fetch(`/api/matches/${matchId}/route?from=${capital}&to=${regionId}&speed=${balance.capital.wagonSpeed}`, { credentials: "include" }).then((r) => r.json() as Promise<{ seconds?: number; error?: string }>),
    enabled: confirm && !!capital,
  });
  const m = useMutation({
    mutationFn: () => api.setCapital(matchId, regionId),
    onSuccess: () => {
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
    },
  });
  const old = state.owned.find((o) => o.regionId === capital);
  const stores = old ? Math.min(balance.capital.wagonCarry, Math.floor(old.food + old.wood + old.stone + Object.values(old.special).reduce((x, y) => x + y, 0))) : 0;
  if (wagon) {
    const here = wagon.targetRegionId === regionId;
    return (
      <div className="mt-2 rounded-md border border-amber-400/30 bg-amber-400/5 px-2 py-1.5 text-xs text-amber-100">
        Capital wagon on its way to {regionById(wagon.targetRegionId)?.name}{here ? " (here)" : ""}: arrives in <Countdown to={wagon.arrivesAt} clockOffsetMs={clockOffsetMs} />.
      </div>
    );
  }
  return (
    <div className="mt-2">
      {!confirm ? (
        <button
          type="button"
          onClick={() => setConfirm(true)}
          className="inline-flex items-center gap-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-400/20"
        >
          <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true" className="shrink-0">
            <path d="M1 7h10l2-4h2v5h-1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <rect x="1" y="2" width="9" height="5" rx="1" fill="currentColor" opacity="0.35" />
            <circle cx="4" cy="9.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="12" cy="9.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          Move capital here
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-amber-400/30 bg-amber-400/5 p-2 text-xs">
          <p className="text-amber-100">A capital wagon leaves {old ? regionById(old.regionId)?.name : "your capital"} carrying up to {fmt(balance.capital.wagonCarry)} of its stores ({fmt(stores)} now).</p>
          <p className="text-slate-300">
            Travel: {route.data?.seconds !== undefined ? formatCountdown(route.data.seconds) : route.data?.error ? route.data.error : "…"}. The capital changes when it arrives; research, overflow caravans and loyalty distance then key off this region, which gets{" "}
            {balance.economy.capitalStorageMult}x storage. Every idle caravan then gathers here.
          </p>
          <div className="flex gap-2">
            <Button variant="primary" disabled={m.isPending || !!route.data?.error} onClick={() => m.mutate()}>
              Send the wagon
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </div>
          <ErrorText>{m.error?.message}</ErrorText>
        </div>
      )}
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
              {j.waitingFor ? (
                <span className="text-xs text-amber-300" title={`Waiting for ${Object.entries(j.waitingFor).map(([k, v]) => `${Math.round(v)} ${k}`).join(", ")} to arrive by caravan`}>
                  waiting for materials
                </span>
              ) : (
                <Countdown to={j.endsAt} clockOffsetMs={clockOffsetMs} />
              )}
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

function BuildingTip({ def, level, owned, economy, speed, maxed }: { def: BuildingDef; level: number; owned: OwnedRegionView; economy: RegionEconomy; speed: number; maxed: boolean }) {
  const { summary, rows } = buildingPreview(def, level, owned.buildings, economy, owned.regionId, speed, owned.isCapital);
  const current = owned.buildings[def.id] ?? 0;
  return (
    <div>
      <p className="text-slate-200">{summary}</p>
      {maxed ? <p className="mt-2 text-slate-400">Already at the maximum level.</p> : <BeforeAfter rows={rows} beforeLabel={`lvl ${current}`} afterLabel={`lvl ${level}`} />}
      <p className="mt-2 text-slate-500">Rates are per real hour at {speed}x. Tap to pin this panel.</p>
    </div>
  );
}

function UnitTip({ def, qty, workers, soldiers }: { def: UnitDef; qty: number; workers: number; soldiers: number }) {
  const { summary, rows } = unitPreview(def);
  const n = Math.min(qty, Math.floor(workers));
  return (
    <div>
      <p className="text-slate-200">{summary}</p>
      <BeforeAfter rows={rows.map((r) => ({ ...r, before: "" }))} beforeLabel="" afterLabel="per unit" />
      <BeforeAfter
        rows={[
          { label: "Workers", before: fmt(workers), after: fmt(workers - n), tone: "down" },
          { label: "Soldiers", before: fmt(soldiers), after: fmt(soldiers + n), tone: "up" },
          { label: "Army attack here", before: "", after: `+${n * def.attack}` },
        ]}
        beforeLabel="now"
        afterLabel={`train ${n}`}
      />
    </div>
  );
}

export function ageName(age: number): string {
  return AGES[age as 0 | 1 | 2 | 3 | 4] ?? "Unknown";
}
