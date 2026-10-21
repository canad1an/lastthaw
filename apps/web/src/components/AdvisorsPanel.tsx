import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { availableBuildings, balance, buildingBlockedBy, regionById, type AdvisorKind, type AdvisorSettings, type AdvisorView, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, fmt } from "./ui.js";

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
  noRoute: "no route to safe ground, or to the target",
  ordersFull: "the market allows no more open orders",
};

const ADVISORS: Array<{ kind: AdvisorKind; name: string; title: string; blurb: string; duties: string[]; portrait: string; she: boolean }> = [
  {
    kind: "economic",
    she: true,
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
    she: false,
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
  {
    kind: "thaw",
    she: true,
    name: "Freya",
    title: "the Warden of the Thaw",
    blurb: "Keeper of the ice line. Gets your people, soldiers and stores out of every region before it freezes, moves the capital out of the ice's path, and plants colonies on the warm side.",
    portrait: "/advisors/thaw.jpg",
    duties: [
      "Reads the ice schedule against every region you hold each pass and puts the ones freezing soonest on the clock, with a line each.",
      "Evacuates every region that freezes within the warning you set: people, units and what they can carry go to the safest region of yours with a route (or your capital), the stores following by hauler.",
      "Moves the capital before its slow wagon would be too late, to your longest-lasting populous region, and tells you when it leaves.",
      "While land is being lost, settles the nearest free region on the warm side that stays unfrozen for a week or more, training the settlers where they are short, one colony on the road at a time.",
      "Cannot stop the ice: a region with no safe ground in reach is reported so you can act, and the last stand stays yours to call.",
    ],
  },
  {
    kind: "chancellor",
    she: false,
    name: "Theo",
    title: "the Chancellor",
    blurb: "Keeper of the ledger. Research toward the goal you set, and a trader on the market who sells what overflows and buys what your orders owe.",
    portrait: "/advisors/chancellor.jpg",
    duties: [
      "Fills the research queue toward your goal (the next age, hauling, walls or the sea) in prerequisite order, a few techs a pass, and always leaves two slots free for you.",
      "Lists any store above four fifths of its cap on the market at the fair price, asking for what your waiting orders owe or the ore you hold least, and withdraws a listing nobody takes in twelve hours.",
      "Buys what waiting builds, training and the next research owe from the cheapest open offer that is not too far above fair, into your capital, keeping a reserve there.",
      "Reports every tech queued, every listing and every purchase, and what the market could not supply.",
      "Never touches buildings, armies, people or diplomacy.",
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
  const [confirm, setConfirm] = useState<{ what: "hire" | "fire"; kind: AdvisorKind } | null>(null);
  const [view, setView] = useState<"roster" | AdvisorKind>("roster");
  const regions = state.owned.length;
  const hired = (kind: AdvisorKind) => state.advisors.find((a) => a.kind === kind) ?? null;
  const wageOf = (kind: AdvisorKind) => hired(kind)?.wage ?? state.advisorWage;

  const dialog =
    confirm &&
    (() => {
      const meta = ADVISORS.find((x) => x.kind === confirm.kind)!;
      const wage = wageOf(confirm.kind);
      const pronoun = meta.she ? "her" : "him";
      const she = meta.she ? "She" : "He";
      return createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" onClick={() => setConfirm(null)} role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-white">
              {confirm.what === "hire" ? "Hire" : "Fire"} {meta.name}, {meta.title}?
            </h2>
            {confirm.what === "hire" ? (
              <div className="mt-2 space-y-2 text-sm text-slate-300">
                <p>
                  The wage, every game hour, at your empire's output today ({regions} region{regions === 1 ? "" : "s"}). Nothing is paid on hiring; the first hour is charged at the next tick:
                </p>
                <ul className="grid grid-cols-2 gap-1 rounded border border-slate-800 p-2 text-slate-100 sm:grid-cols-3">
                  {Object.entries(wage).map(([k, v]) => (
                    <li key={k} className="flex justify-between gap-2 px-1">
                      <span className="text-slate-400">{k}</span>
                      <span className="tabular-nums">{fmt(v)}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-slate-400">Nothing is paid up front: the wage is charged every game hour, starting at the next tick, and {she.toLowerCase()} starts work once that first hour is charged, within five minutes. The wage is {Math.round(balance.advisors.outputShare * 100)}% of the food, wood and stone your empire gathers each hour, measured as you go, so it grows as you do; it is paid by value in any mix of the three (stone counts 1.2), spread over whatever you hold, capital first. Only if your food, wood and stone together are worth less than an hour's wage does {she.toLowerCase()} stop until it is paid. You can fire {pronoun} at any time: the hours used are billed on the way out, at least one, and {she.toLowerCase()} will not come back for {balance.advisors.rehireCooldownHours} game hours.</p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-300">{she} leaves at once. Builds and training already queued, and armies and convoys already on the road, carry on. The hours used since the last charge are billed now, at least one hour. {she} will not take you back for {balance.advisors.rehireCooldownHours} game hours.</p>
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
              {Date.parse(current.paidUntil) <= Date.parse(current.hiredAt) && <span className="text-amber-300"> · starts at the next tick, once the first hour is charged</span>}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button className="rounded border border-rose-500/50 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20" onClick={() => setConfirm({ what: "fire", kind: view })}>
                Fire
              </button>
              <ErrorText>{fire.error?.message}</ErrorText>
            </div>
          </div>
        </Card>
        {view === "economic" ? <SettingsForm matchId={matchId} state={state} advisor={current} /> : view === "military" ? <MilitarySettings matchId={matchId} state={state} advisor={current} onSelect={onSelect} /> : view === "thaw" ? <ThawSettings matchId={matchId} state={state} advisor={current} onSelect={onSelect} /> : <ChancellorSettings matchId={matchId} state={state} advisor={current} />}
        {current.lastReport && <Report advisor={current} onSelect={onSelect} />}
        {dialog}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 text-sm">
      <p className="text-xs text-slate-400">Advisors take routine management off your hands for a steep hourly wage: each takes {Math.round(balance.advisors.outputShare * 100)}% of the food, wood and stone your empire gathers, measured as you grow. Nothing is paid on hiring and work starts once the first hour is charged, at the next tick; fire at any time, but the hours used are billed on the way out and a fired advisor stays away for {balance.advisors.rehireCooldownHours} game hours.</p>
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
                  {wageLine(wage)} an hour, {Math.round(balance.advisors.outputShare * 100)}% of the food, wood and stone you gather, payable in any mix of the three by value
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

/**
 * The form's draft follows the saved settings only when they really change (a save, or another device): the match
 * state polls every few seconds and hands over a fresh settings object each time, which must not wipe an unsaved edit.
 */
function useSavedSettings(saved: AdvisorSettings, setDraft: (s: AdvisorSettings) => void): void {
  const synced = useRef(JSON.stringify(saved));
  useEffect(() => {
    const now = JSON.stringify(saved);
    if (now === synced.current) return;
    synced.current = now;
    setDraft(saved);
  }, [saved, setDraft]);
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
  useSavedSettings(advisor.settings, setDraft);
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
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={draft.disbandIdle} onChange={(e) => setDraft((d) => ({ ...d, disbandIdle: e.target.checked }))} className="mt-0.5 accent-sky-400" />
            <span>Disband idle soldiers: an interior region holding more than the garrison, with no exposed front to send them to and no muster there, sends the surplus back to work, a few regions a pass. Campaigns raise fresh troops near their target instead of marching old ones across the map.</span>
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
                  <button className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-400 hover:border-rose-400/60 hover:text-rose-200" onClick={() => untarget.mutate(id)} title="Take this region off the Military advisor's list">
                    remove
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

function ThawSettings({ matchId, state, advisor, onSelect }: { matchId: string; state: MatchStateView; advisor: AdvisorView; onSelect: (regionId: string) => void }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
  const [draft, setDraft] = useState<AdvisorSettings>(advisor.settings);
  useSavedSettings(advisor.settings, setDraft);
  const save = useMutation({ mutationFn: (s: AdvisorSettings) => api.setAdvisorSettings(matchId, "thaw", s), onSuccess: refresh });
  const dirty = JSON.stringify(draft) !== JSON.stringify(advisor.settings);
  const regions = useMemo(() => [...state.owned].sort((a, b) => Number(b.isCapital) - Number(a.isCapital) || (regionById(a.regionId)?.name ?? "").localeCompare(regionById(b.regionId)?.name ?? "")), [state.owned]);
  const clock = advisor.lastReport?.clock ?? [];
  const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
  return (
    <>
      <Card className="space-y-3">
        <h3 className="font-semibold text-white">Ahead of the ice</h3>
        <div className="grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1">
            <span>Evacuate this many game hours before a region freezes</span>
            <input type="number" min={6} max={120} value={draft.warningHours} onChange={(e) => setDraft((d) => ({ ...d, warningHours: num(e.target.value, 6, 120) }))} className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100" />
          </label>
          <label className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1">
            <span>Move the capital this many hours before (the wagon is slow)</span>
            <input type="number" min={12} max={168} value={draft.capitalHours} onChange={(e) => setDraft((d) => ({ ...d, capitalHours: num(e.target.value, 12, 168) }))} className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100" />
          </label>
        </div>
        <div className="text-xs text-slate-300">
          {(
            [
              ["safest", "Safest ground", "evacuees go to the nearest region of yours that outlasts theirs by a safe margin, or the longest-lasting one in reach."],
              ["capital", "The capital", "everyone goes to your capital while it is safe itself; otherwise the safest ground."],
            ] as const
          ).map(([v, label, text]) => (
            <label key={v} className="flex items-start gap-2 py-0.5">
              <input type="radio" name="advisor-destination" checked={draft.destination === v} onChange={() => setDraft((d) => ({ ...d, destination: v }))} className="mt-0.5 accent-sky-400" />
              <span>
                <span className="text-slate-100">{label}.</span> {text}
              </span>
            </label>
          ))}
        </div>
        <div className="space-y-1 text-xs text-slate-300">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={draft.moveCapital} onChange={(e) => setDraft((d) => ({ ...d, moveCapital: e.target.checked }))} className="mt-0.5 accent-sky-400" />
            <span>Move the capital out of the ice's path, to your longest-lasting populous region with a route.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={draft.settle} onChange={(e) => setDraft((d) => ({ ...d, settle: e.target.checked }))} className="mt-0.5 accent-sky-400" />
            <span>Settle the warm side while regions are on the clock: the nearest free region that stays unfrozen a week or more, one colony on the road at a time, settlers trained where they are short.</span>
          </label>
        </div>
        <details className="text-xs text-slate-300">
          <summary className="cursor-pointer text-slate-400">Regions she leaves alone ({draft.skipRegions.length})</summary>
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

      {clock.length > 0 && (
        <Card className="space-y-2">
          <h3 className="font-semibold text-white">On the clock</h3>
          <ul className="space-y-1 text-xs text-slate-300">
            {clock.map((l) => (
              <li key={l.regionId} className="flex items-start gap-2">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums ${l.hoursLeft <= advisor.settings.warningHours ? "bg-rose-500/20 text-rose-200" : "bg-sky-500/20 text-sky-200"}`}>{l.hoursLeft} h</span>
                <span className="min-w-0 flex-1">{l.text}</span>
                <button className="shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-500/20" onClick={() => onSelect(l.regionId)}>
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

const GOALS: ReadonlyArray<[AdvisorSettings["researchGoal"], string, string]> = [
  ["age", "The next age", "every prerequisite of the age's tech in order, then the tech itself the day it opens."],
  ["hauling", "Hauling", "the next hauler: Wagon building, then Wainwrights, Railways and Internal combustion, each rebuilding your whole fleet."],
  ["walls", "Walls", "the path to Concrete: masonry, fortification, mathematics and engineering."],
  ["sea", "The sea", "the path to Navigation: sailing, carpentry, shipbuilding and cartography."],
  ["off", "No research", "the queue is yours alone."],
];

function ChancellorSettings({ matchId, state, advisor }: { matchId: string; state: MatchStateView; advisor: AdvisorView }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
  const [draft, setDraft] = useState<AdvisorSettings>(advisor.settings);
  useSavedSettings(advisor.settings, setDraft);
  const save = useMutation({ mutationFn: (s: AdvisorSettings) => api.setAdvisorSettings(matchId, "chancellor", s), onSuccess: refresh });
  const dirty = JSON.stringify(draft) !== JSON.stringify(advisor.settings);
  const regions = useMemo(() => [...state.owned].sort((a, b) => Number(b.isCapital) - Number(a.isCapital) || (regionById(a.regionId)?.name ?? "").localeCompare(regionById(b.regionId)?.name ?? "")), [state.owned]);
  const pct = (v: number) => Math.round(v * 100);
  const fromPct = (s: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, (Number(s) || lo * 100) / 100));
  return (
    <Card className="space-y-3">
      <h3 className="font-semibold text-white">Research goal</h3>
      <div className="text-xs text-slate-300">
        {GOALS.map(([v, label, text]) => (
          <label key={v} className="flex items-start gap-2 py-0.5">
            <input type="radio" name="advisor-goal" checked={draft.researchGoal === v} onChange={() => setDraft((d) => ({ ...d, researchGoal: v }))} className="mt-0.5 accent-sky-400" />
            <span>
              <span className="text-slate-100">{label}.</span> {text}
            </span>
          </label>
        ))}
      </div>
      <h3 className="font-semibold text-white">The market</h3>
      <div className="space-y-1 text-xs text-slate-300">
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={draft.sell} onChange={(e) => setDraft((d) => ({ ...d, sell: e.target.checked }))} className="mt-0.5 accent-sky-400" />
          <span>Sell: list any store above the share below of its cap, at the fair price, for what your orders owe or the ore you hold least; withdraw listings nobody takes in {balance.advisors.chancellor.staleHours} hours.</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={draft.buy} onChange={(e) => setDraft((d) => ({ ...d, buy: e.target.checked }))} className="mt-0.5 accent-sky-400" />
          <span>Buy: what waiting builds, training and the next research owe, from the cheapest open offer not above fair by more than the margin below, into the capital, keeping the reserve below of its cap.</span>
        </label>
      </div>
      <div className="grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1">
          <span>Sell above (% of a store's cap)</span>
          <input type="number" min={50} max={98} value={pct(draft.sellAbove)} onChange={(e) => setDraft((d) => ({ ...d, sellAbove: fromPct(e.target.value, 0.5, 0.98) }))} className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100" />
        </label>
        <label className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1">
          <span>Pay up to (% of fair)</span>
          <input type="number" min={100} max={300} value={pct(draft.overpay)} onChange={(e) => setDraft((d) => ({ ...d, overpay: fromPct(e.target.value, 1, 3) }))} className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100" />
        </label>
        <label className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1">
          <span>Reserve kept at the capital (% of its cap)</span>
          <input type="number" min={0} max={90} value={pct(draft.reserveShare)} onChange={(e) => setDraft((d) => ({ ...d, reserveShare: fromPct(e.target.value, 0, 0.9) }))} className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100" />
        </label>
        <label className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1">
          <span>His listings at once</span>
          <input type="number" min={1} max={10} value={draft.maxOrders} onChange={(e) => setDraft((d) => ({ ...d, maxOrders: Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1))) }))} className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100" />
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
  );
}

function SettingsForm({ matchId, state, advisor }: { matchId: string; state: MatchStateView; advisor: AdvisorView }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<AdvisorSettings>(advisor.settings);
  const [allLevel, setAllLevel] = useState(3);
  useSavedSettings(advisor.settings, setDraft);
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
        {buildings.map((b) => {
          // Where the building can stand, how many regions have it at its top level, and how many meet the minimum set.
          const eligible = state.owned.filter((o) => !o.frozen && !buildingBlockedBy(b, regionById(o.regionId)!, o.buildings, o.isCapital));
          const atMax = eligible.filter((o) => (o.buildings[b.id] ?? 0) >= b.maxLevel).length;
          const min = draft.minLevels[b.id] ?? 0;
          const atMin = min > 0 ? eligible.filter((o) => (o.buildings[b.id] ?? 0) >= min).length : null;
          const building = new Set(state.jobs.filter((j) => j.kind === "build" && j.refId === b.id && j.regionId).map((j) => j.regionId)).size;
          return (
          <label key={b.id} className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1 text-xs">
            <span className="text-slate-200">
              {b.name} <span className="text-slate-500">max {b.maxLevel}</span>
              <span className="block text-[11px] text-slate-500" data-building-progress={b.id}>
                {atMax} / {eligible.length} at max level{atMin !== null ? ` · ${atMin} at level ${min} or more` : ""}{building ? ` · ${building} building now` : ""}
              </span>
            </span>
            <input type="number" min={0} max={b.maxLevel} value={draft.minLevels[b.id] ?? 0} onChange={(e) => setLevel(b.id, Math.max(0, Math.min(b.maxLevel, Number(e.target.value) || 0)))} className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100" data-advisor-level={b.id} />
          </label>
          );
        })}
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
        {r.disbanded ? `, sent ${r.disbanded} idle soldier${r.disbanded === 1 ? "" : "s"} back to work` : ""}
        {r.evacuated ? `, evacuated ${r.evacuated} region${r.evacuated === 1 ? "" : "s"}` : ""}
        {r.settled ? `, sent ${r.settled} colon${r.settled === 1 ? "y" : "ies"}` : ""}
        {r.researched ? `, queued ${r.researched} tech${r.researched === 1 ? "" : "s"}` : ""}
        {r.listed ? `, listed ${r.listed} offer${r.listed === 1 ? "" : "s"}` : ""}
        {r.bought ? `, bought ${r.bought} lot${r.bought === 1 ? "" : "s"}` : ""}
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
