import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { availableBuildings, balance, regionById, type AdvisorKind, type AdvisorSettings, type AdvisorView, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, fmt } from "./ui.js";

/** The hourly wage of an advisor for an empire of `regions` regions, as the server computes it. */
export function advisorWage(kind: AdvisorKind, regions: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(balance.advisors[kind].perRegionPerHour)) out[k] = Math.max(1, Math.ceil(v * Math.max(1, regions)));
  return out;
}
export const economicWage = (regions: number) => advisorWage("economic", regions);

const wageLine = (w: Record<string, number>) =>
  Object.entries(w)
    .map(([k, v]) => `${fmt(v)} ${k}`)
    .join(", ");

const SKIP_LABEL: Record<string, string> = {
  unaffordable: "could not be paid for yet",
  queueFull: "build queue full",
  blocked: "cannot stand there, or needs another building first",
  notYetAvailable: "needs an age or tech you do not have",
  haulingBusy: "enough builds already waiting on hauling",
  protected: "target under beginner protection",
  pact: "target under a pact or ceasefire",
  noRoute: "no land route to the target",
};

const ADVISORS: Array<{ kind: AdvisorKind; name: string; title: string; blurb: string; duties: string[]; portrait: string }> = [
  {
    kind: "economic",
    name: "Mara",
    title: "the Economic advisor",
    blurb: "Keeper of stores and roads. Buildings, supply and people across every region, so you do not have to open each one.",
    portrait: "/advisors/economic.jpg",
    duties: [
      "Raises every building in every region to the minimum levels you set, a few builds a pass, in the order the land needs them.",
      "Lets the convoys bring what a region cannot pay, from the capital and the nearest stocked regions, when you allow it.",
      "Sets each region's workers between food, wood and stone from what the region and the empire need: full stores get no more, waiting builds get what they owe, and nobody goes hungry.",
      "Moves people the way you choose: not at all, overflow from crowded regions to neighbours, or balanced across the empire.",
      "Leaves you a report after every pass: what was queued, what was skipped and why, and suggestions that open the region.",
      "Never spends on research, armies or the market; those stay yours.",
    ],
  },
  {
    kind: "military",
    name: "Max",
    title: "the Military advisor",
    blurb: "A general for hire. Holds your borders and takes the regions you mark, to the stance you set.",
    portrait: "/advisors/military.jpg",
    duties: [
      "Draws the front every pass: which of your regions border rivals or neutral tribes, what faces them, and how exposed each one is.",
      "Garrisons and walls the exposed: trains the best soldier of your age toward the garrison you set, moves surplus soldiers in from the interior, and queues a Palisade, Walls and a Watchtower where they are needed.",
      "Takes the regions you mark on the map, up to three campaigns at once: scouts first, then a muster at your nearest region with a land route, then the attack. A beaten force musters again larger; two defeats and he gives up on that one.",
      "Aggressive: picks weak neighbours himself when your list has room, and raids rich ones with soldiers to spare. Passive: defence only.",
      "Never attacks allies, pact partners or tribes under beginner protection, and never touches research or the market.",
    ],
  },
];

/**
 * Advisors: hired staff who take routine management off your hands for a steep hourly wage.
 * The roster shows each advisor with a portrait and what they do; Hire opens the wage; once hired, Manage opens the settings.
 */
export function AdvisorsPanel({ matchId, state, onSelect, clockOffsetMs }: { matchId: string; state: MatchStateView; onSelect: (regionId: string) => void; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
  const hire = useMutation({ mutationFn: (kind: AdvisorKind) => api.hireAdvisor(matchId, kind), onSuccess: refresh });
  const fire = useMutation({
    mutationFn: (kind: AdvisorKind) => api.fireAdvisor(matchId, kind),
    onSuccess: () => {
      refresh();
      setView("roster");
    },
  });
  const run = useMutation({ mutationFn: (kind: AdvisorKind) => api.runAdvisor(matchId, kind), onSuccess: refresh });
  const [confirm, setConfirm] = useState<{ what: "hire" | "fire"; kind: AdvisorKind } | null>(null);
  const [view, setView] = useState<"roster" | AdvisorKind>("roster");
  const regions = state.owned.length;
  const hired = (kind: AdvisorKind) => state.advisors.find((a) => a.kind === kind) ?? null;
  const wageOf = (kind: AdvisorKind) => hired(kind)?.wage ?? advisorWage(kind, regions);

  const dialog =
    confirm &&
    (() => {
      const meta = ADVISORS.find((x) => x.kind === confirm.kind)!;
      const wage = wageOf(confirm.kind);
      const pronoun = confirm.kind === "economic" ? "her" : "him";
      const she = confirm.kind === "economic" ? "She" : "He";
      return createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" onClick={() => setConfirm(null)} role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-white">
              {confirm.what === "hire" ? "Hire" : "Fire"} {meta.name}, {meta.title}?
            </h2>
            {confirm.what === "hire" ? (
              <div className="mt-2 space-y-2 text-sm text-slate-300">
                <p>
                  The wage, every game hour, for your {regions} region{regions === 1 ? "" : "s"}:
                </p>
                <ul className="grid grid-cols-2 gap-1 rounded border border-slate-800 p-2 text-slate-100 sm:grid-cols-3">
                  {Object.entries(wage).map(([k, v]) => (
                    <li key={k} className="flex justify-between gap-2 px-1">
                      <span className="text-slate-400">{k}</span>
                      <span className="tabular-nums">{fmt(v)}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-slate-400">The first hour is taken now, from your capital first, then every game hour after. The wage grows with the regions you hold. No hiring fee. If a wage cannot be met {she.toLowerCase()} stops until it is paid. Fire {pronoun} at any time.</p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-300">{she} leaves at once. Builds and training already queued, and armies and convoys already on the road, carry on. You can rehire at any time with no fee.</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800" onClick={() => setConfirm(null)} autoFocus>
                Cancel
              </button>
              <button
                className={confirm.what === "hire" ? "btn-ember rounded-md px-4 py-2 text-sm font-semibold" : "rounded-md border border-rose-500/50 bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/30"}
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  if (c.what === "hire") hire.mutate(c.kind);
                  else fire.mutate(c.kind);
                }}
              >
                {confirm.what === "hire" ? `Yes, hire ${pronoun}` : `Yes, fire ${pronoun}`}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      );
    })();

  const current = view !== "roster" ? hired(view) : null;
  if (view !== "roster" && current) {
    const meta = ADVISORS.find((x) => x.kind === view)!;
    return (
      <div className="space-y-3 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button className="text-xs text-sky-400 hover:underline" onClick={() => setView("roster")}>
            ← All advisors
          </button>
          <StatusBadge a={current} />
        </div>
        <Card className="flex items-center gap-3">
          <img src={meta.portrait} alt="" className="h-14 w-14 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 text-xs text-slate-400">
            <p className="text-sm font-semibold text-white">
              {meta.name}, {meta.title}
            </p>
            <p>
              Wage {wageLine(current.wage)} an hour · paid until <Countdown until={current.paidUntil} clockOffsetMs={clockOffsetMs} /> · last pass {current.lastPassAt ? <Ago at={current.lastPassAt} clockOffsetMs={clockOffsetMs} /> : "not yet"}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => run.mutate(view)} disabled={run.isPending || current.unpaid}>
                Run a pass now
              </Button>
              <button className="rounded border border-rose-500/50 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20" onClick={() => setConfirm({ what: "fire", kind: view })}>
                Fire
              </button>
              <ErrorText>{run.error?.message ?? fire.error?.message}</ErrorText>
            </div>
          </div>
        </Card>
        {view === "economic" ? <SettingsForm matchId={matchId} state={state} advisor={current} /> : <MilitarySettings matchId={matchId} state={state} advisor={current} onSelect={onSelect} />}
        {current.lastReport && <Report advisor={current} onSelect={onSelect} />}
        {dialog}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 text-sm">
      <p className="text-xs text-slate-400">Advisors take routine management off your hands for a steep hourly wage. You hire them and you fire them; there is no fee either way.</p>
      {ADVISORS.map((meta) => {
        const a = hired(meta.kind);
        const wage = wageOf(meta.kind);
        return (
          <Card key={meta.kind} className="flex flex-col items-center gap-3 text-center sm:flex-row sm:items-start sm:text-left">
            <img src={meta.portrait} alt={`${meta.name}, ${meta.title}`} className="h-36 w-36 shrink-0 rounded-full shadow-lg" data-advisor-portrait={meta.kind} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                <h3 className="text-base font-semibold text-white">
                  {meta.name}, {meta.title}
                </h3>
                {a ? <StatusBadge a={a} /> : <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">not hired</span>}
              </div>
              <p className="mt-1 text-xs text-slate-400">{meta.blurb}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-left text-xs text-slate-300">
                {meta.duties.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                {a ? (
                  <>
                    <Button onClick={() => setView(meta.kind)}>Manage</Button>
                    <button className="rounded border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/20" onClick={() => setConfirm({ what: "fire", kind: meta.kind })}>
                      Fire
                    </button>
                  </>
                ) : (
                  <Button onClick={() => setConfirm({ what: "hire", kind: meta.kind })} disabled={hire.isPending}>
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
        );
      })}
      {dialog}
    </div>
  );
}

function StatusBadge({ a }: { a: AdvisorView }) {
  const label = a.unpaid ? "unpaid, not working" : a.kind === "military" ? `Hired · ${a.settings.stance}` : "Hired";
  return <span className={`rounded px-2 py-0.5 text-xs ${a.unpaid ? "bg-rose-500/20 text-rose-200" : "bg-emerald-500/20 text-emerald-200"}`}>{label}</span>;
}

const STANCES: Array<[AdvisorSettings["stance"], string, string]> = [
  ["passive", "Passive", "Defence only: garrisons, reinforcements and walls on exposed border regions. No attacks, even on marked targets."],
  ["measured", "Measured", "Defence, plus campaigns against the regions you mark, in order."],
  ["aggressive", "Aggressive", "Measured, and when your list has room he picks weak neighbours himself; with raids on, he raids rich weak neighbours with soldiers to spare."],
];

function MilitarySettings({ matchId, state, advisor, onSelect }: { matchId: string; state: MatchStateView; advisor: AdvisorView; onSelect: (regionId: string) => void }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
  const [draft, setDraft] = useState<AdvisorSettings>(advisor.settings);
  useEffect(() => setDraft(advisor.settings), [advisor.settings]);
  const save = useMutation({ mutationFn: (s: AdvisorSettings) => api.setAdvisorSettings(matchId, "military", s), onSuccess: refresh });
  const untarget = useMutation({ mutationFn: (regionId: string) => api.setAdvisorTarget(matchId, regionId, false), onSuccess: refresh });
  const dirty = JSON.stringify(draft) !== JSON.stringify(advisor.settings);
  const regions = useMemo(() => [...state.owned].sort((a, b) => Number(b.isCapital) - Number(a.isCapital) || (regionById(a.regionId)?.name ?? "").localeCompare(regionById(b.regionId)?.name ?? "")), [state.owned]);
  const open = advisor.campaigns.filter((c) => c.stage !== "done" && c.stage !== "failed");
  const closed = advisor.campaigns.filter((c) => c.stage === "done" || c.stage === "failed");
  return (
    <>
      <Card className="space-y-3">
        <h3 className="font-semibold text-white">Stance and orders</h3>
        <div className="text-xs text-slate-300">
          {STANCES.map(([v, label, text]) => (
            <label key={v} className="flex items-start gap-2 py-0.5">
              <input type="radio" name="advisor-stance" checked={draft.stance === v} onChange={() => setDraft((d) => ({ ...d, stance: v }))} className="mt-0.5 accent-sky-400" />
              <span>
                <span className="text-slate-100">{label}.</span> {text}
              </span>
            </label>
          ))}
        </div>
        <div className="grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1">
            <span>Garrison per border region</span>
            <input type="number" min={0} max={500} value={draft.garrison} onChange={(e) => setDraft((d) => ({ ...d, garrison: Math.max(0, Math.min(500, Number(e.target.value) || 0)) }))} className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100" />
          </label>
          <label className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1">
            <span>Campaigns at once</span>
            <select value={draft.maxCampaigns} onChange={(e) => setDraft((d) => ({ ...d, maxCampaigns: Number(e.target.value) }))} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100">
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="space-y-1 text-xs text-slate-300">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={draft.fortify} onChange={(e) => setDraft((d) => ({ ...d, fortify: e.target.checked }))} className="mt-0.5 accent-sky-400" />
            <span>Fortify: queue a Palisade, then Walls, then a Watchtower on exposed border regions, supplied like any build.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={draft.scoutFirst} onChange={(e) => setDraft((d) => ({ ...d, scoutFirst: e.target.checked }))} className="mt-0.5 accent-sky-400" />
            <span>Scout first: no attack without a sighting younger than {balance.advisors.military.sightingMaxHours} hours or a watchtower view. Off, he sizes the force from what is known or guessed.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={draft.raids} onChange={(e) => setDraft((d) => ({ ...d, raids: e.target.checked }))} className="mt-0.5 accent-sky-400" />
            <span>Raids (aggressive only): one a pass, from a border region with soldiers to spare, against the weakest rich neighbour.</span>
          </label>
        </div>
        <details className="text-xs text-slate-300">
          <summary className="cursor-pointer text-slate-400">Regions he leaves alone ({draft.skipRegions.length})</summary>
          <div className="mt-1 grid gap-0.5 sm:grid-cols-2">
            {regions.map((r) => (
              <label key={r.regionId} className="flex items-center gap-2">
                <input type="checkbox" checked={draft.skipRegions.includes(r.regionId)} onChange={(e) => setDraft((d) => ({ ...d, skipRegions: e.target.checked ? [...d.skipRegions, r.regionId] : d.skipRegions.filter((x) => x !== r.regionId) }))} className="accent-sky-400" />
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

      <Card className="space-y-2">
        <h3 className="font-semibold text-white">Targets</h3>
        <p className="text-xs text-slate-400">Mark a region from its panel on the map (⚔ Target for the Military advisor). They are taken in this order, up to the campaigns at once you allow.</p>
        {advisor.settings.targets.length === 0 ? (
          <p className="text-xs text-slate-500">No targets marked{advisor.settings.stance === "aggressive" ? "; he picks his own." : "."}</p>
        ) : (
          <ol className="space-y-0.5 text-xs text-slate-300">
            {advisor.settings.targets.map((id, i) => {
              const c = advisor.campaigns.find((x) => x.targetRegionId === id && x.stage !== "done" && x.stage !== "failed");
              return (
                <li key={id} className="flex items-center gap-2">
                  <span className="w-5 text-right text-slate-500">{i + 1}.</span>
                  <button className="min-w-0 flex-1 truncate text-left hover:text-white" onClick={() => onSelect(id)}>
                    {regionById(id)?.name ?? id}
                    {c ? <span className="text-slate-500"> · {c.stage}</span> : null}
                  </button>
                  <button className="shrink-0 text-slate-500 hover:text-rose-300" onClick={() => untarget.mutate(id)} title="Remove">
                    ✕
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <ErrorText>{untarget.error?.message}</ErrorText>
      </Card>

      {(open.length > 0 || closed.length > 0) && (
        <Card className="space-y-2">
          <h3 className="font-semibold text-white">Campaigns</h3>
          <ul className="space-y-1 text-xs text-slate-300">
            {[...open, ...closed].map((c) => (
              <li key={`${c.targetRegionId}-${c.startedAt}`} className="flex items-start gap-2">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase ${c.stage === "done" ? "bg-emerald-500/20 text-emerald-200" : c.stage === "failed" ? "bg-rose-500/20 text-rose-200" : "bg-sky-500/20 text-sky-200"}`}>{c.stage}</span>
                <span className="min-w-0 flex-1">
                  <span className="text-slate-100">{regionById(c.targetRegionId)?.name ?? c.targetRegionId}</span>
                  {c.note ? ` · ${c.note}` : ""}
                </span>
                <button className="shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-500/20" onClick={() => onSelect(c.targetRegionId)}>
                  Open region →
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(advisor.lastReport?.exposed.length ?? 0) > 0 && (
        <Card className="space-y-2">
          <h3 className="font-semibold text-white">Exposed regions</h3>
          <ul className="space-y-1 text-xs text-slate-300">
            {advisor.lastReport!.exposed.map((e) => (
              <li key={e.regionId} className="flex items-start gap-2">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${e.exposure >= 2 ? "bg-rose-500/20 text-rose-200" : e.exposure >= 1 ? "bg-amber-500/20 text-amber-200" : "bg-emerald-500/20 text-emerald-200"}`}>{e.exposure.toFixed(1)}</span>
                <span className="min-w-0 flex-1">{e.text}</span>
                <button className="shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-500/20" onClick={() => onSelect(e.regionId)}>
                  Open region →
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
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
      <label className="flex items-start gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={draft.workers} onChange={(e) => setDraft((d) => ({ ...d, workers: e.target.checked }))} className="mt-0.5 accent-sky-400" />
        <span>Set worker shares: each pass, every region's split between food, wood and stone is set from what it and the empire need. Full stores get no more, waiting builds get what they owe, and no region is left to starve. Off, your own sliders stand.</span>
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
        {r.rebalanced ? `, reset the workers of ${r.rebalanced} region${r.rebalanced === 1 ? "" : "s"}` : ""}
        {r.trained ? `, ordered ${fmt(r.trained)} soldiers` : ""}
        {r.fortified ? `, queued ${r.fortified} wall${r.fortified === 1 ? "" : "s"}` : ""}
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
