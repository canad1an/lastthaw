import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  computeRates,
  normalizeAssignment,
  regionById,
  settle,
  totalPopulation,
  type MatchStateView,
  type OwnedRegionView,
  type RegionEconomy,
  type SightedRegionView,
} from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { useNow } from "../hooks/useNow.js";
import { Button, Card, ErrorText, fmt, signed } from "./ui.js";

interface Props {
  matchId: string;
  state: MatchStateView;
  regionId: string;
  /** Offset to add to local time to get match time, in ms. */
  clockOffsetMs: number;
  onClose: () => void;
}

export function RegionPanel({ matchId, state, regionId, clockOffsetMs, onClose }: Props) {
  const region = regionById(regionId);
  const owned = state.owned.find((o) => o.regionId === regionId) ?? null;
  const sighted = state.sighted.find((s) => s.regionId === regionId) ?? null;
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
        <OwnedDetails matchId={matchId} owned={owned} clockOffsetMs={clockOffsetMs} speed={state.match.speed} />
      ) : sighted ? (
        <SightedDetails s={sighted} />
      ) : (
        <p className="text-sm text-slate-400">You have no recent information about this region. Scouting arrives in a later milestone.</p>
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

function OwnedDetails({ matchId, owned, clockOffsetMs, speed }: { matchId: string; owned: OwnedRegionView; clockOffsetMs: number; speed: number }) {
  const now = useNow(1000);
  const region = regionById(owned.regionId)!;
  const traits = { terrain: region.terrain, resources: region.resources, coastal: region.coastal, river: region.river };

  // Project the server snapshot forward with the same pure settle the server uses.
  const live = useMemo(() => {
    const base: RegionEconomy = {
      popWorkers: owned.popWorkers,
      popSoldiers: owned.popSoldiers,
      popOccupiers: owned.popOccupiers,
      food: owned.food,
      wood: owned.wood,
      stone: owned.stone,
      assignment: owned.assignment,
      storage: owned.storage,
      capacity: owned.capacity,
      frozen: owned.frozen,
    };
    const elapsed = Math.max(0, (now + clockOffsetMs - Date.parse(owned.asOf)) / 1000);
    const e = settle(traits, base, elapsed, speed);
    return { e, rates: computeRates(traits, e) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owned, now, clockOffsetMs, speed]);

  const pop = totalPopulation(live.e);
  const perHour = (v: number) => signed(v * speed, 1);

  return (
    <div className="space-y-3">
      {owned.isCapital && <span className="inline-block rounded bg-sky-500/20 px-1.5 py-0.5 text-xs text-sky-300">Capital</span>}
      <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-sm">
        <Row label="People" value={fmt(pop)} rate={perHour(live.rates.population)} />
        <Row label="Food" value={`${fmt(live.e.food)} / ${fmt(live.e.storage.food)}`} rate={perHour(live.rates.food)} warn={live.rates.starving} />
        <Row label="Wood" value={`${fmt(live.e.wood)} / ${fmt(live.e.storage.wood)}`} rate={perHour(live.rates.wood)} />
        <Row label="Stone" value={`${fmt(live.e.stone)} / ${fmt(live.e.storage.stone)}`} rate={perHour(live.rates.stone)} />
      </dl>
      {live.rates.starving && <p className="text-sm text-rose-400">Your people are starving. Assign more workers to food.</p>}
      <p className="text-xs text-slate-500">Rates are per real hour at {speed}x speed.</p>
      <AssignmentEditor matchId={matchId} owned={owned} workers={live.e.popWorkers} />
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
