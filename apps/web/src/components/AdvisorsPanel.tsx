import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { availableBuildings, balance, regionById, type AdvisorSettings, type AdvisorView, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, fmt } from "./ui.js";

/** The hourly wage of the Economic advisor for an empire of `regions` regions, as the server computes it. */
export function economicWage(regions: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(balance.advisors.economic.perRegionPerHour)) out[k] = Math.max(1, Math.ceil(v * Math.max(1, regions)));
  return out;
}

const wageLine = (w: Record<string, number>) =>
  Object.entries(w)
    .map(([k, v]) => `${fmt(v)} ${k}`)
    .join(", ");

const SKIP_LABEL: Record<string, string> = {
  unaffordable: "could not be paid for yet",
  queueFull: "build queue full",
  blocked: "cannot stand there, or needs another building first",
  notYetAvailable: "needs an age or tech you do not have",
};

const ECONOMIC_DUTIES = [
  "Raises every building in every region to the minimum levels you set, a few builds a pass, in the order the land needs them.",
  "Lets the convoys bring what a region cannot pay, from the capital and the nearest stocked regions, when you allow it.",
  "Moves people the way you choose: not at all, overflow from crowded regions to neighbours, or balanced across the empire.",
  "Leaves you a report after every pass: what was queued, what was skipped and why, and suggestions that open the region.",
  "Never spends on research, armies or the market; those stay yours.",
];

/**
 * Advisors: hired staff who take routine management off your hands for a steep hourly wage.
 * The roster shows each advisor with a portrait and what they do; Hire opens the wage; once hired, Manage opens the settings.
 */
export function AdvisorsPanel({ matchId, state, onSelect, clockOffsetMs }: { matchId: string; state: MatchStateView; onSelect: (regionId: string) => void; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
  const economic = state.advisors.find((a) => a.kind === "economic") ?? null;
  const hire = useMutation({ mutationFn: () => api.hireAdvisor(matchId, "economic"), onSuccess: refresh });
  const fire = useMutation({
    mutationFn: () => api.fireAdvisor(matchId, "economic"),
    onSuccess: () => {
      refresh();
      setView("roster");
    },
  });
  const run = useMutation({ mutationFn: () => api.runAdvisor(matchId, "economic"), onSuccess: refresh });
  const [confirm, setConfirm] = useState<"hire" | "fire" | null>(null);
  const [view, setView] = useState<"roster" | "economic">("roster");
  const wage = economic?.wage ?? economicWage(state.owned.length);
  const regions = state.owned.length;

  const dialog =
    confirm &&
    createPortal(
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" onClick={() => setConfirm(null)} role="dialog" aria-modal="true">
        <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-lg font-semibold text-white">{confirm === "hire" ? "Hire Mara, the Economic advisor?" : "Fire Mara, the Economic advisor?"}</h2>
          {confirm === "hire" ? (
            <div className="mt-2 space-y-2 text-sm text-slate-300">
              <p>
                Her wage, every game hour, for your {regions} region{regions === 1 ? "" : "s"}:
              </p>
              <ul className="grid grid-cols-2 gap-1 rounded border border-slate-800 p-2 text-slate-100 sm:grid-cols-3">
                {Object.entries(wage).map(([k, v]) => (
                  <li key={k} className="flex justify-between gap-2 px-1">
                    <span className="text-slate-400">{k}</span>
                    <span className="tabular-nums">{fmt(v)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-slate-400">The first hour is taken now, from your capital first, then every game hour after. The wage grows with the regions you hold. No hiring fee. If a wage cannot be met she stops until it is paid. Fire her at any time.</p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-300">She leaves at once. Builds already queued and convoys already on the road carry on. You can rehire at any time with no fee.</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800" onClick={() => setConfirm(null)} autoFocus>
              Cancel
            </button>
            <button
              className={confirm === "hire" ? "btn-ember rounded-md px-4 py-2 text-sm font-semibold" : "rounded-md border border-rose-500/50 bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/30"}
              onClick={() => {
                setConfirm(null);
                if (confirm === "hire") hire.mutate();
                else fire.mutate();
              }}
            >
              {confirm === "hire" ? "Yes, hire her" : "Yes, fire her"}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );

  if (view === "economic" && economic) {
    return (
      <div className="space-y-3 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button className="text-xs text-sky-400 hover:underline" onClick={() => setView("roster")}>
            ← All advisors
          </button>
          <span className={`rounded px-2 py-0.5 text-xs ${economic.unpaid ? "bg-rose-500/20 text-rose-200" : "bg-emerald-500/20 text-emerald-200"}`}>{economic.unpaid ? "unpaid, not working" : "Hired"}</span>
        </div>
        <Card className="flex items-center gap-3">
          <img src="/advisors/economic.svg" alt="" className="h-14 w-14 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 text-xs text-slate-400">
            <p className="text-sm font-semibold text-white">Mara, the Economic advisor</p>
            <p>
              Wage {wageLine(wage)} an hour · paid until <Countdown until={economic.paidUntil} clockOffsetMs={clockOffsetMs} /> · last pass {economic.lastPassAt ? <Ago at={economic.lastPassAt} clockOffsetMs={clockOffsetMs} /> : "not yet"}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => run.mutate()} disabled={run.isPending || economic.unpaid}>
                Run a pass now
              </Button>
              <button className="rounded border border-rose-500/50 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20" onClick={() => setConfirm("fire")}>
                Fire
              </button>
              <ErrorText>{run.error?.message ?? fire.error?.message}</ErrorText>
            </div>
          </div>
        </Card>
        <SettingsForm matchId={matchId} state={state} advisor={economic} />
        {economic.lastReport && <Report advisor={economic} onSelect={onSelect} />}
        {dialog}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 text-sm">
      <p className="text-xs text-slate-400">Advisors take routine management off your hands for a steep hourly wage. You hire them and you fire them; there is no fee either way.</p>
      <Card className="flex flex-col items-center gap-3 text-center sm:flex-row sm:items-start sm:text-left">
        <img src="/advisors/economic.svg" alt="Mara, the Economic advisor" className="h-36 w-36 shrink-0 rounded-full shadow-lg" data-advisor-portrait="economic" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
            <h3 className="text-base font-semibold text-white">Mara, the Economic advisor</h3>
            {economic ? (
              <span className={`rounded px-2 py-0.5 text-xs ${economic.unpaid ? "bg-rose-500/20 text-rose-200" : "bg-emerald-500/20 text-emerald-200"}`}>{economic.unpaid ? "unpaid, not working" : "Hired"}</span>
            ) : (
              <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">not hired</span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-400">Keeper of stores and roads. Buildings, supply and people across every region, so you do not have to open each one.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-left text-xs text-slate-300">
            {ECONOMIC_DUTIES.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
            {economic ? (
              <>
                <Button onClick={() => setView("economic")}>Manage</Button>
                <button className="rounded border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/20" onClick={() => setConfirm("fire")}>
                  Fire
                </button>
              </>
            ) : (
              <Button onClick={() => setConfirm("hire")} disabled={hire.isPending}>
                Hire
              </Button>
            )}
            <span className="text-xs text-slate-500">
              {wageLine(wage)} an hour for {regions} region{regions === 1 ? "" : "s"}
            </span>
            <ErrorText>{hire.error?.message ?? fire.error?.message}</ErrorText>
          </div>
        </div>
      </Card>
      <p className="text-xs text-slate-500">More advisors will join the roster: a Military advisor is next.</p>
      {dialog}
    </div>
  );
}

function SettingsForm({ matchId, state, advisor }: { matchId: string; state: MatchStateView; advisor: AdvisorView }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<AdvisorSettings>(advisor.settings);
  const [allLevel, setAllLevel] = useState(3);
  useEffect(() => setDraft(advisor.settings), [advisor.settings]);
  const save = useMutation({ mutationFn: (s: AdvisorSettings) => api.setAdvisorSettings(matchId, "economic", s), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  const buildings = useMemo(() => availableBuildings(state.me.age, new Set(state.me.techs)).filter((b) => !b.wonder), [state.me.age, state.me.techs]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(advisor.settings);
  const setLevel = (id: string, v: number) =>
    setDraft((d) => {
      const minLevels = { ...d.minLevels };
      if (v > 0) minLevels[id] = v;
      else delete minLevels[id];
      return { ...d, minLevels };
    });
  const regions = [...state.owned].sort((a, b) => Number(b.isCapital) - Number(a.isCapital) || (regionById(a.regionId)?.name ?? "").localeCompare(regionById(b.regionId)?.name ?? ""));
  return (
    <Card className="space-y-3">
      <h3 className="font-semibold text-white">What to keep up</h3>
      <p className="text-xs text-slate-400">The minimum level of each building you want in every region where it can stand (0 leaves it alone). The advisor raises them as resources allow, a few builds per pass, and never adds to a region whose queue is full.</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
        <span>Set every building to</span>
        <input type="number" min={0} max={50} value={allLevel} onChange={(e) => setAllLevel(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100" data-advisor-all />
        <Button
          variant="ghost"
          className="px-2 py-1 text-xs"
          onClick={() =>
            setDraft((d) => {
              const minLevels: Record<string, number> = {};
              if (allLevel > 0) for (const b of buildings) minLevels[b.id] = Math.min(allLevel, b.maxLevel);
              return { ...d, minLevels };
            })
          }
        >
          Apply to all
        </Button>
        <span className="text-slate-500">Each building is capped at its own maximum; 0 clears every minimum. Adjust single buildings below afterwards.</span>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {buildings.map((b) => (
          <label key={b.id} className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1 text-xs">
            <span className="text-slate-200">
              {b.name} <span className="text-slate-500">max {b.maxLevel}</span>
            </span>
            <input type="number" min={0} max={b.maxLevel} value={draft.minLevels[b.id] ?? 0} onChange={(e) => setLevel(b.id, Math.max(0, Math.min(b.maxLevel, Number(e.target.value) || 0)))} className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100" data-advisor-level={b.id} />
          </label>
        ))}
      </div>
      <label className="flex items-start gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={draft.useOtherRegions} onChange={(e) => setDraft((d) => ({ ...d, useOtherRegions: e.target.checked }))} className="mt-0.5 accent-sky-400" />
        <span>Use other regions' resources: queue a build the region cannot pay for and let convoys bring the rest from the capital and the nearest stocked regions. Off, each region pays for its own.</span>
      </label>
      <div className="text-xs text-slate-300">
        <p className="mb-1 font-medium text-slate-200">People</p>
        {(
          [
            ["off", "Leave people where they are."],
            ["overflow", "Overflow: a region over its capacity sends part of the surplus each hour to neighbouring regions of yours with room."],
            ["balanced", "Balanced: every region toward the same share of its capacity; columns of people leave the fullest regions for the emptiest, a few percent per pass."],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="flex items-start gap-2 py-0.5">
            <input type="radio" name="advisor-population" checked={draft.population === v} onChange={() => setDraft((d) => ({ ...d, population: v }))} className="mt-0.5 accent-sky-400" />
            <span>{label}</span>
          </label>
        ))}
        <p className="mt-1 text-slate-500">Without an Economic advisor nobody moves on their own; you move people by hand.</p>
      </div>
      <details className="text-xs text-slate-300">
        <summary className="cursor-pointer text-slate-400">Regions the advisor leaves alone ({draft.skipRegions.length})</summary>
        <div className="mt-1 grid gap-0.5 sm:grid-cols-2">
          {regions.map((r) => (
            <label key={r.regionId} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.skipRegions.includes(r.regionId)}
                onChange={(e) => setDraft((d) => ({ ...d, skipRegions: e.target.checked ? [...d.skipRegions, r.regionId] : d.skipRegions.filter((x) => x !== r.regionId) }))}
                className="accent-sky-400"
              />
              <span>
                {regionById(r.regionId)?.name ?? r.regionId}
                {r.isCapital ? <span className="text-slate-500"> (capital)</span> : null}
              </span>
            </label>
          ))}
        </div>
      </details>
      <div className="flex items-center gap-2">
        <Button onClick={() => save.mutate(draft)} disabled={!dirty || save.isPending}>
          Save
        </Button>
        {save.isSuccess && !dirty && <span className="text-xs text-emerald-300">Saved.</span>}
        <ErrorText>{save.error?.message}</ErrorText>
      </div>
    </Card>
  );
}

function Report({ advisor, onSelect }: { advisor: AdvisorView; onSelect: (regionId: string) => void }) {
  const r = advisor.lastReport!;
  const skipped = Object.entries(r.skipped).filter(([, n]) => n > 0);
  return (
    <Card className="space-y-2">
      <h3 className="font-semibold text-white">Last pass</h3>
      <p className="text-xs text-slate-300">
        Queued {r.queued} build{r.queued === 1 ? "" : "s"}
        {r.moved ? `, moved ${fmt(r.moved)} people` : ""}
        {skipped.length ? `; skipped ${skipped.map(([k, n]) => `${n} (${SKIP_LABEL[k] ?? k})`).join(", ")}` : ""}.
      </p>
      {r.suggestions.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Suggestions</p>
          <ul className="space-y-1 text-xs text-slate-300">
            {r.suggestions.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="min-w-0 flex-1">{s.text}</span>
                {s.regionId && (
                  <button className="shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-500/20" onClick={() => onSelect(s.regionId!)}>
                    Open region →
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Countdown({ until, clockOffsetMs }: { until: string; clockOffsetMs: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const secs = (Date.parse(until) - (Date.now() + clockOffsetMs)) / 1000;
  if (secs <= 0) return <span>now (next charge due)</span>;
  const mins = Math.round(secs / 60);
  return <span>{mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`} from now</span>;
}

function Ago({ at, clockOffsetMs }: { at: string; clockOffsetMs: number }) {
  const mins = Math.max(0, Math.round((Date.now() + clockOffsetMs - Date.parse(at)) / 60_000));
  return <span>{mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`}</span>;
}
