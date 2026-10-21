import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AGES, availableBuildings, availableUnits, buildingBlockedBy, balance, buildingById, buildingCost, matchDayOf, buildingSeconds, canAfford, computeRates, normalizeAssignment, realSeconds, regionById, settle, totalPopulation, trainSeconds, unitById, unitCost, formatCountdown, type MatchStateView, type OwnedRegionView, type RegionEconomy, type SightedRegionView, type SpecialResource, distanceKm, NOTE_COLOURS, type NoteColour, loyaltyBand, loyaltyOutlook, HAULER_IDS, haulerCarry, type AgeIndex } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { useNow } from "../hooks/useNow.js";
import { Button, Card, ErrorText, fmt, signed } from "./ui.js";
import { UnitIcon } from "./UnitIcon.js";
import { Countdown, CostLine, JobTime } from "./Countdown.js";
import { SendArmy } from "./ArmyPanel.js";
import { ColonizePanel } from "./ColonizePanel.js";
import { EvacuatePanel } from "./EvacuatePanel.js";
import { BeforeAfter, Tooltip } from "./Tooltip.js";
import { buildingPreview, unitPreview } from "./previews.js";
import { BUILDINGS, BUILDING_CATEGORIES, TECHS, UNITS, type BuildingCategory, type BuildingDef, type UnitDef } from "@lastthaw/shared";

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

export type RegionTab = "overview" | "build" | "train" | "units";
type Tab = RegionTab;

/** The desktop card: a header with the name and a close button around the shared body. */
export function RegionPanel({ matchId, state, regionId, clockOffsetMs, onClose, target, onPickTarget, onClearTarget }: Props) {
  const region = regionById(regionId);
  const myNote = state.notes.find((n) => n.regionId === regionId) ?? null;
  const [tab, setTab] = useState<Tab>("overview");
  useEffect(() => setTab("overview"), [regionId]);
  if (!region) return null;

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold leading-tight">
            {myNote?.colour && <span className="inline-block h-3 w-3 shrink-0 rounded-full ring-2 ring-white/70" style={{ background: NOTE_HEX[myNote.colour] }} title={`Marked ${myNote.colour}`} />}
            {region.name}
          </h2>
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
      <RegionBody matchId={matchId} state={state} regionId={regionId} clockOffsetMs={clockOffsetMs} tab={tab} onTab={setTab} target={target} onPickTarget={onPickTarget} onClearTarget={onClearTarget} />
    </Card>
  );
}

/**
 * What a region shows once you are looking at it: resources, notes, and for your own land the overview, build, train
 * and units tabs with the queue beneath. The desktop wraps it in a card; a phone gives it a whole screen.
 */
export function RegionBody({ matchId, state, regionId, clockOffsetMs, tab, onTab, target, onPickTarget, onClearTarget }: Omit<Props, "onClose"> & { tab: RegionTab; onTab: (t: RegionTab) => void }) {
  const region = regionById(regionId);
  const owned = state.owned.find((o) => o.regionId === regionId) ?? null;
  const sighted = state.sighted.find((s) => s.regionId === regionId) ?? null;
  if (!region) return null;
  return (
    <>
    <p className="text-sm text-slate-300">
      Resources: <span className="text-slate-100">{region.resources.map((r) => r.replace("_", " ")).join(", ")}</span>
    </p>
    {!state.observer && <RegionNotes matchId={matchId} state={state} regionId={regionId} />}
    {!state.observer && (!owned || state.advisors.some((a) => a.kind === "military" && a.settings.targets.includes(regionId))) && <TargetToggle matchId={matchId} state={state} regionId={regionId} />}
    {!state.observer && owned && <ExposureLine state={state} regionId={regionId} />}
    {owned ? (
      <>
        <nav className="flex gap-1 overflow-x-auto border-b border-slate-800 text-sm">
          {(["overview", "build", "train", "units"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => onTab(t)}
              className={`shrink-0 px-3 py-2.5 capitalize sm:py-1.5 ${tab === t ? "border-b-2 border-sky-400 text-white" : "text-slate-400 hover:text-slate-200"}`}
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
    ) : state.observer ? (
      <p className="text-sm text-slate-400">Nobody holds this region.</p>
    ) : (
      <ScoutHere matchId={matchId} state={state} regionId={regionId} />
    )}
    </>
  );
}

/**
 * An unknown region: the hint, and if Scouts are standing in a region of yours, a one-tap scout from the nearest few.
 */
function ScoutHere({ matchId, state, regionId }: { matchId: string; state: MatchStateView; regionId: string }) {
  const qc = useQueryClient();
  const options = useMemo(() => {
    const out: Array<{ from: string; unitId: string; km: number; have: number }> = [];
    for (const r of state.owned) {
      if (r.frozen) continue;
      const have = r.units[balance.scoutUnit] ?? 0;
      if (have <= 0) continue;
      out.push({ from: r.regionId, unitId: balance.scoutUnit, km: distanceKm(r.regionId, regionId), have });
    }
    return out.sort((a, b) => a.km - b.km).slice(0, 3);
  }, [state.owned, regionId]);
  // How many to send: a party is safer in a held region (the report arrives if any get through), at the cost of more scouts at risk.
  const [count, setCount] = useState(1);
  const most = Math.min(10, Math.max(1, ...options.map((o) => o.have)));
  const n = Math.min(count, most);
  const send = useMutation({
    mutationFn: (o: { from: string; unitId: string; have: number }) => api.sendArmy(matchId, o.from, { mission: "scout", targetRegionId: regionId, units: { [o.unitId]: Math.min(n, o.have) }, people: 0, cargo: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  const already = state.armies.some((a) => a.mission === "scout" && a.targetRegionId === regionId);
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-400">You have no recent information about this region. Send a scout to learn more.</p>
      {already ? (
        <p className="text-sm text-emerald-300">A scout of yours is on the way.</p>
      ) : options.length > 0 ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Scouts to send</span>
            <button type="button" className="h-7 w-7 rounded border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-40" onClick={() => setCount((c) => Math.max(1, c - 1))} disabled={n <= 1} aria-label="fewer scouts">
              −
            </button>
            <span className="w-5 text-center text-sm text-slate-100" data-scout-count>
              {n}
            </span>
            <button type="button" className="h-7 w-7 rounded border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-40" onClick={() => setCount((c) => Math.min(most, c + 1))} disabled={n >= most} aria-label="more scouts">
              +
            </button>
            <span className="text-slate-500" title="In a held region each scout may be caught; the report arrives if any get through">{n === 1 ? "one may be caught where soldiers stand" : "the report arrives if any get through"}</span>
          </div>
          {options.map((o) => {
            const k = Math.min(n, o.have);
            return (
              <Button key={o.from} variant="ghost" className="w-full justify-between text-left" disabled={send.isPending} onClick={() => send.mutate(o)} title="They ride there, look around and come home; what they see goes into your notes on the region">
                <span>
                  Scout with {k} {unitById.get(o.unitId)?.name ?? o.unitId}
                  {k === 1 ? "" : "s"} from {regionById(o.from)?.name ?? o.from}
                  {k < n ? <span className="text-slate-500"> (all it has)</span> : null}
                </span>
                <span className="text-xs text-slate-400">{Math.round(o.km)} km</span>
              </Button>
            );
          })}
          {send.isSuccess && <p className="text-xs text-emerald-300">Sent.</p>}
          <ErrorText>{send.error?.message}</ErrorText>
        </div>
      ) : (
        <p className="text-xs text-slate-500">No Scouts at home. Train some under a region's Train tab: fast and cheap, and the only unit that can scout.</p>
      )}
    </div>
  );
}

/** Mark a region for the Military advisor to take, when he is hired. */
function TargetToggle({ matchId, state, regionId }: { matchId: string; state: MatchStateView; regionId: string }) {
  const qc = useQueryClient();
  const max = state.advisors.find((a) => a.kind === "military");
  const set = useMutation({ mutationFn: (add: boolean) => api.setAdvisorTarget(matchId, regionId, add), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  if (!max) return null;
  const on = max.settings.targets.includes(regionId);
  const idx = max.settings.targets.indexOf(regionId);
  const campaign = max.campaigns.find((c) => c.targetRegionId === regionId && c.stage !== "done" && c.stage !== "failed");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={`rounded-md border px-2 py-0.5 text-xs font-medium ${on ? "border-rose-400/60 bg-rose-500/20 text-rose-100 hover:bg-rose-500/30" : "border-rose-400/40 bg-rose-400/10 text-rose-200 hover:bg-rose-400/20"}`}
        onClick={() => set.mutate(!on)}
        disabled={set.isPending}
        title={on ? "Remove this region from the Military advisor's targets" : "Have the Military advisor scout, muster against and take this region"}
        data-advisor-target
      >
        {on ? `⚔ Target ${idx + 1} for the Military advisor (remove)` : "⚔ Target for the Military advisor"}
      </button>
      {campaign && <span className="text-xs text-slate-400">{campaign.note || campaign.stage}</span>}
      <ErrorText>{set.error?.message}</ErrorText>
    </div>
  );
}

/** How exposed one of my regions is, from the Military advisor's last pass. */
function ExposureLine({ state, regionId }: { state: MatchStateView; regionId: string }) {
  const max = state.advisors.find((a) => a.kind === "military");
  const e = max?.lastReport?.exposed.find((x) => x.regionId === regionId);
  if (!max || !e) return null;
  const level = e.exposure >= 2 ? ["high", "text-rose-300"] : e.exposure >= 1 ? ["raised", "text-amber-300"] : ["low", "text-emerald-300"];
  return (
    <p className="text-xs text-slate-400">
      Exposure <span className={level[1]}>{level[0]}</span> · {e.text}
    </p>
  );
}

export const NOTE_HEX: Record<NoteColour, string> = { red: "#f43f5e", amber: "#f59e0b", green: "#22c55e", blue: "#38bdf8", purple: "#a78bfa" };

/** The player's own marker and notes on this region: pick a colour to pin it on the map, write what you know. Nobody else sees it. */
function RegionNotes({ matchId, state, regionId }: { matchId: string; state: MatchStateView; regionId: string }) {
  const qc = useQueryClient();
  const note = state.notes.find((n) => n.regionId === regionId) ?? null;
  const [open, setOpen] = useState(!!note);
  const [text, setText] = useState(note?.text ?? "");
  const [colour, setColour] = useState<NoteColour | null>(note?.colour ?? null);
  useEffect(() => {
    setText(note?.text ?? "");
    setColour(note?.colour ?? null);
    setOpen(!!note);
  }, [regionId, note?.text, note?.colour]);
  const save = useMutation({
    mutationFn: (b: { text: string; colour: NoteColour | null }) => api.setNote(matchId, regionId, b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  const dirty = text.trim() !== (note?.text ?? "") || colour !== (note?.colour ?? null);
  if (!open) {
    return (
      <button type="button" className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-200 hover:bg-amber-400/20" onClick={() => setOpen(true)} title="Pin this region on your map with a colour and keep private notes on it">
        ✎ Mark region and add notes
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded border border-slate-800 bg-slate-900/60 p-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">Marker</span>
        {NOTE_COLOURS.map((c) => (
          <button
            key={c}
            aria-label={`${c} marker`}
            title={c}
            onClick={() => {
              const next = colour === c ? null : c;
              setColour(next);
              save.mutate({ text: text.trim(), colour: next });
            }}
            className={`h-5 w-5 rounded-full border-2 ${colour === c ? "border-white" : "border-transparent opacity-60 hover:opacity-100"}`}
            style={{ background: NOTE_HEX[c] }}
          />
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, 500))}
        placeholder="Your notes on this region: who holds it, what you saw, what you plan. Only you can read them."
        rows={2}
        className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-500"
      />
      <div className="flex items-center gap-2">
        <Button onClick={() => save.mutate({ text: text.trim(), colour })} disabled={!dirty || save.isPending}>
          Save note
        </Button>
        {note && (
          <Button
            variant="ghost"
            onClick={() => {
              setText("");
              setColour(null);
              save.mutate({ text: "", colour: null });
            }}
            disabled={save.isPending}
          >
            Remove
          </Button>
        )}
        {!note && (
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
        {save.isSuccess && !dirty && <span className="text-xs text-slate-500">Saved</span>}
      </div>
      <ErrorText>{save.error?.message}</ErrorText>
    </div>
  );
}

function SightedDetails({ s }: { s: SightedRegionView }) {
  return (
    <div className="text-sm text-slate-300">
      <p>Owner: {s.ownerName ?? "nobody"}</p>
      {s.wall && <p>Defences: {buildingById.get(s.wall)?.name ?? s.wall}</p>}
      <p>Population: {s.population === null ? "unknown" : fmt(s.population)}</p>
      {s.units && (
        <p title="Seen live from a Watchtower of yours next door">
          Units there now:{" "}
          {Object.entries(s.units).length
            ? Object.entries(s.units)
                .map(([id, n]) => `${n} ${unitById.get(id)?.name ?? id}`)
                .join(", ")
            : "none"}
        </p>
      )}
      {!s.ownerName && (s.population ?? 0) > 0 && (
        <p className="mt-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-100" title="Neutral tribes are never under protection">
          A neutral tribe: a few warriors guarding a hoard of copper, tin or iron. Raid it from day one; no protection applies.
        </p>
      )}
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
      abandoned: owned.evacuated,
      frozen: owned.frozen,
      storm: !!owned.stormUntil,
      plague: !!owned.plagueUntil,
      boom: owned.boom?.resource ?? null,
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
      {owned.isCapital && !owned.frozen && <Rally matchId={matchId} state={state} />}
      {owned.isCapital && !owned.frozen && state.lastStand.eligible && <LastStand matchId={matchId} state={state} />}
      {owned.frozen && <span className="ml-2 inline-block rounded bg-cyan-200/20 px-1.5 py-0.5 text-xs text-cyan-200">Frozen</span>}
      {owned.evacuated && !owned.frozen && <span className="ml-2 inline-block rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300" title="Nobody lives here: no growth or production until people move back in">Evacuated</span>}
      {owned.stormUntil && <span className="ml-2 inline-block rounded bg-sky-200/20 px-1.5 py-0.5 text-xs text-sky-100" title="Half production and double travel while it blows">Blizzard · {formatCountdown(Math.max(0, (Date.parse(owned.stormUntil) - Date.now() - clockOffsetMs) / 1000))}</span>}
      {owned.plagueUntil && <span className="ml-2 inline-block rounded bg-rose-500/20 px-1.5 py-0.5 text-xs text-rose-200" title="No growth and people dying each hour. Herbal medicine halves the risk; Vaccination and Sanitation end it">Sickness · {formatCountdown(Math.max(0, (Date.parse(owned.plagueUntil) - Date.now() - clockOffsetMs) / 1000))}</span>}
      {owned.thawUntil && <span className="ml-2 inline-block rounded bg-amber-400/20 px-1.5 py-0.5 text-xs text-amber-200" title="A warm pocket: the ice passes this region by until then">Thaw pocket · {formatCountdown(Math.max(0, (Date.parse(owned.thawUntil) - Date.now() - clockOffsetMs) / 1000))}</span>}
      {owned.boom && <span className="ml-2 inline-block rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs text-emerald-200" title="Output of this resource is doubled">Rich {owned.boom.resource} · {formatCountdown(Math.max(0, (Date.parse(owned.boom.until) - Date.now() - clockOffsetMs) / 1000))}</span>}
      {!owned.isCapital && !owned.frozen && <MakeCapital matchId={matchId} state={state} regionId={owned.regionId} clockOffsetMs={clockOffsetMs} />}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm">
        <Row label="People" value={`${fmt(pop)} / ${fmt(live.e.capacity)}`} rate={perHour(live.rates.population)} />
        <dt className="text-slate-500">of which</dt>
        <dd className="col-span-2 text-xs text-slate-400">
          {fmt(live.e.popWorkers)} workers{live.e.popSoldiers > 0 ? `, ${fmt(live.e.popSoldiers)} in units` : ""}{live.e.popOccupiers > 0 ? `, ${fmt(live.e.popOccupiers)} occupiers` : ""}. Counts only who is here now, not units on the road.
          {pop > live.e.capacity && (
            <span className="text-amber-300">
              {" "}
              Over capacity: growth has stopped.{" "}
              {state.advisors.some((a) => a.kind === "economic" && !a.unpaid && a.settings.population !== "off")
                ? `Your Economic advisor moves the surplus (${Math.round(balance.economy.migrationPerHour * 100)}% an hour to neighbours with room, or balanced across your regions).`
                : "Move people out by hand, or hire an Economic advisor to do it."}
            </span>
          )}
        </dd>
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
        <label key={k} className="grid grid-cols-[4rem_minmax(0,1fr)_3rem] items-center gap-2 text-sm">
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

const CATEGORY_TONE: Record<BuildingCategory, string> = {
  growth: "border-lime-500/60 bg-lime-950/20 [&_h4]:text-lime-300",
  production: "border-orange-500/60 bg-orange-950/20 [&_h4]:text-orange-300",
  storage: "border-yellow-500/60 bg-yellow-950/20 [&_h4]:text-yellow-300",
  defense: "border-rose-500/60 bg-rose-950/20 [&_h4]:text-rose-300",
  training: "border-violet-500/60 bg-violet-950/20 [&_h4]:text-violet-300",
  transport: "border-sky-500/60 bg-sky-950/20 [&_h4]:text-sky-300",
  loyalty: "border-fuchsia-500/60 bg-fuchsia-950/20 [&_h4]:text-fuchsia-300",
  wonder: "border-red-500/80 bg-red-950/30 [&_h4]:text-red-200",
};

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
  const renderRows = (bs: BuildingDef[]) => (
    <>
        {bs.map((b) => {
          const queued = pendingHere.filter((j) => j.kind === "build" && j.refId === b.id).length;
          const level = (owned.buildings[b.id] ?? 0) + queued + 1;
          const maxed = level > b.maxLevel;
          const cost = buildingCost(b, level, matchDayOf(state, clockOffsetMs), regionById(owned.regionId)?.neighbors.length ?? 1);
          const blocked = buildingBlockedBy(b, regionById(owned.regionId)!, owned.buildings, owned.isCapital);
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
    </>
  );
  return (
    <div className="space-y-2">
      {queueFull && <p className="text-xs text-amber-300">Queue full ({balance.queue.slotsPerRegion} slots).</p>}
      <ErrorText>{m.error?.message}</ErrorText>
      {BUILDING_CATEGORIES.map((c) => {
        const bs = list.filter((b) => b.category === c.id);
        if (!bs.length) return null;
        const built = bs.filter((b) => (owned.buildings[b.id] ?? 0) > 0).length;
        return (
          <section key={c.id} className={`rounded-lg border-l-4 px-3 py-2 ${CATEGORY_TONE[c.id]}`}>
            <h4 className="flex items-center gap-1.5 text-sm font-semibold">
              <span aria-hidden>{c.icon}</span>
              {c.name}
              {built > 0 && <span className="rounded-full bg-slate-800 px-2 text-xs font-normal text-slate-200">{built} of {bs.length} built</span>}
            </h4>
            <p className="mb-1 text-xs text-slate-400">{c.hint}</p>
            <ul className="divide-y divide-slate-800/70">{renderRows(bs)}</ul>
          </section>
        );
      })}
      <NextAge age={state.me.age} items={BUILDINGS.filter((b) => b.age === state.me.age + 1 && (!b.requires || techs.has(b.requires))).map((b) => ({ name: b.name, description: b.description }))} />
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
  const here = (us: UnitDef[]) => us.reduce((a, u) => a + (owned.units[u.id] ?? 0), 0);
  const groups = [
    { title: "Army", icon: "⚔", tone: "border-rose-500/60 bg-rose-950/20", text: "text-rose-300", hint: "Fight on land: raid, conquer, defend.", units: list.filter((u) => !u.civilian && !u.naval && !u.hauler) },
    { title: "Ships", icon: "⛵", tone: "border-sky-500/60 bg-sky-950/20", text: "text-sky-300", hint: "Sail one sea lane at a time; need a Harbor. Patrol lanes and fight other ships.", units: list.filter((u) => u.naval) },
    { title: "Haulers", icon: "🛒", tone: "border-amber-500/60 bg-amber-950/20", text: "text-amber-300", hint: "Carry goods on routes, transports and builds. No fighting.", units: list.filter((u) => u.hauler && !u.naval) },
    { title: "Settlers", icon: "🏕", tone: "border-emerald-500/60 bg-emerald-950/20", text: "text-emerald-300", hint: "Found colonies and occupy conquests. No fighting.", units: list.filter((u) => u.civilian && !u.hauler && !u.naval) },
  ].filter((g) => g.units.length);
  const renderRows = (units: UnitDef[]) => (
    <>
        {units.map((u) => {
          const n = Math.max(qty, 1, u.minBatch ?? 1);
          const cost = unitCost(u, n, matchDayOf(state, clockOffsetMs));
          // A mount comes out of the stores (the cost line shows horses in red when short); only a unit that needs a resource it does not pay for must stand where it is found.
          const needs = (u.needsResource && !(u.cost[u.needsResource] ?? 0) && !region.resources.includes(u.needsResource)) || (u.naval && !region.coastal) || (u.needsBuilding && (owned.buildings[u.needsBuilding] ?? 0) < 1);
          const ok = !queueFull && !needs && canAfford(stock, cost) && live.e.popWorkers >= n;
          const secs = realSeconds(trainSeconds(u, n), owned.effects.trainSpeed, state.match.speed);
          return (
            <li key={u.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <Tooltip
                className="min-w-0 flex-1 cursor-help"
                trigger={
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <UnitIcon id={u.id} className="h-6 w-6 text-slate-200" />
                      <span className="font-medium">{u.name}</span>
                      {(owned.units[u.id] ?? 0) > 0 && <span className="rounded bg-slate-800 px-1.5 text-xs text-slate-300">{fmt(owned.units[u.id]!)} here</span>}
                      <span className="text-xs text-slate-500">
                        atk {u.attack} · def {u.defense} · spd {u.speed}{u.carry ? ` · carry ${fmt(u.carry)}` : ""}{u.breach ? ` · siege ${u.breach}` : ""}
                      </span>
                      <span className="text-xs text-slate-600">ⓘ</span>
                    </div>
                    {needs ? (
                      <p className="text-xs text-rose-400">needs {u.needsResource ? `${u.needsResource} here` : u.naval && !region.coastal ? "a coast" : `a ${buildingById.get(u.needsBuilding ?? "")?.name ?? u.needsBuilding} here`}</p>
                    ) : (
                      <p><CostLine cost={cost} stock={stock} suffix={formatCountdown(secs)} /></p>
                    )}
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
    </>
  );
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-slate-400">Batch size</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={1000}
          value={qty === 0 ? "" : qty}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setQty(e.target.value === "" ? 0 : Math.min(1000, Math.max(0, Math.floor(Number(e.target.value)) || 0)))}
          onBlur={() => setQty((q) => Math.max(1, q))}
          className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1"
          aria-label="Batch size"
        />
        <span className="text-xs text-slate-500">free workers {fmt(live.e.popWorkers)}</span>
      </label>
      {queueFull && <p className="text-xs text-amber-300">Queue full.</p>}
      <ErrorText>{m.error?.message}</ErrorText>
      {groups.map((g) => (
        <section key={g.title} className={`rounded-lg border-l-4 ${g.tone} px-3 py-2`}>
          <h4 className="flex items-baseline justify-between gap-2">
            <span className={`flex items-center gap-1.5 text-sm font-semibold ${g.text}`}>
              <span aria-hidden>{g.icon}</span>
              {g.title}
              {here(g.units) > 0 && <span className="rounded-full bg-slate-800 px-2 text-xs font-normal text-slate-200">{fmt(here(g.units))} here</span>}
            </span>
          </h4>
          <p className="mb-1 text-xs text-slate-400">{g.hint}</p>
          <ul className="divide-y divide-slate-800/70">
            {renderRows(g.units)}
          </ul>
        </section>
      ))}
      <NextAge age={state.me.age} items={UNITS.filter((u) => u.age === state.me.age + 1 && !u.hidden && (!u.requires || techs.has(u.requires))).map((u) => ({ name: u.name, description: u.description }))} />
    </div>
  );
}

/** What the next age brings that you already have the tech for: visible now, buildable then, so a researched Farm is never a mystery. */
function NextAge({ age, items }: { age: number; items: Array<{ name: string; description: string }> }) {
  if (items.length === 0 || age + 1 >= AGES.length) return null;
  const next = AGES[(age + 1) as AgeIndex];
  const advance = TECHS.find((t) => t.age === age && t.advancesTo === age + 1);
  return (
    <section className="rounded-lg border-l-4 border-slate-600 bg-slate-900/40 px-3 py-2 opacity-80">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-300">
        <span aria-hidden>🔒</span>
        Coming with the {next} Age
      </h4>
      <p className="mb-1 text-xs text-slate-400">
        You have the techs for these; they open when you reach the {next} Age{advance ? ` (research ${advance.name})` : ""}.
      </p>
      <ul className="divide-y divide-slate-800/70">
        {items.map((it) => (
          <li key={it.name} className="py-1.5 text-sm">
            <span className="font-medium text-slate-300">{it.name}</span>
            <p className="truncate text-xs text-slate-500">{it.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArmyTab({ matchId, owned, state }: { matchId: string; owned: OwnedRegionView; state: MatchStateView }) {
  const qc = useQueryClient();
  const entries = Object.entries(owned.units).filter(([, n]) => n > 0);
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
              <span className="flex items-center gap-1.5">
                <UnitIcon id={id} className="h-5 w-5 text-slate-300" />
                {unitById.get(id)?.name ?? id}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-slate-300">{n}</span>
                <input
                  type="number"
                  min={0}
                  max={n}
                  value={disbanding[id] ?? 0}
                  onFocus={(e) => e.target.select()}
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

/** Call every soldier home: stationed units in all other regions march to the capital; optionally recall armies on missions too. */
/** The ice is a day from the capital: everything marches south at double speed, once. */
function LastStand({ matchId, state }: { matchId: string; state: MatchStateView }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const capLat = Math.abs(regionById(state.me.capitalRegionId ?? "")?.lat ?? 0);
  const options = state.owned.filter((o) => !o.isCapital && !o.frozen && Math.abs(regionById(o.regionId)?.lat ?? 99) < capLat);
  const m = useMutation({
    mutationFn: () => api.lastStand(matchId, target),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
    },
  });
  return (
    <span className="ml-2 inline-block align-middle">
      <button className="rounded border border-rose-500/60 bg-rose-950/40 px-2 py-0.5 text-xs text-rose-200 hover:bg-rose-900/40" onClick={() => setOpen((o) => !o)} title="The ice is a day away: send everything south at double speed">
        🏳 Last stand
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-rose-500/40 bg-slate-950 p-2 text-xs text-slate-300">
          <p>Every person, unit and store leaves this capital for a region of yours nearer the equator, at double speed. The capital moves when they arrive. Once per match.</p>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100">
            <option value="">Choose a region…</option>
            {options.map((o) => (
              <option key={o.regionId} value={o.regionId}>
                {regionById(o.regionId)?.name}
              </option>
            ))}
          </select>
          <Button variant="danger" className="px-3 py-1 text-xs" disabled={!target || m.isPending} onClick={() => m.mutate()}>
            March
          </Button>
          <ErrorText>{m.error?.message}</ErrorText>
        </div>
      )}
    </span>
  );
}

function Rally({ matchId, state }: { matchId: string; state: MatchStateView }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [includeMissions, setIncludeMissions] = useState(false);
  const stationed = state.owned
    .filter((o) => !o.isCapital && !o.frozen)
    .reduce((a, o) => a + Object.entries(o.units).reduce((x, [id, n]) => x + (unitById.get(id)?.civilian ? 0 : n), 0), 0);
  const onMissions = state.armies.filter((a) => a.status === "outbound" && ["raid", "conquer", "reinforce", "scout", "move"].includes(a.mission) && Object.entries(a.units).some(([id, n]) => n > 0 && !unitById.get(id)?.civilian)).length;
  const m = useMutation({
    mutationFn: () => api.rally(matchId, includeMissions),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
    },
  });
  return (
    <span className="ml-2 inline-block align-middle">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-orange-400/40 bg-orange-400/10 px-2 py-0.5 text-xs font-medium text-orange-200 hover:bg-orange-400/20">
          ⚔ Rally army here
        </button>
      ) : (
        <span className="mt-1 block space-y-1 rounded-md border border-orange-400/30 bg-orange-400/5 p-2 text-xs">
          <span className="block text-slate-300">
            {stationed} soldier{stationed === 1 ? "" : "s"} stationed in other regions will march here. Caravans, settlers and wagons stay.
          </span>
          <label className="flex items-center gap-2 text-slate-300">
            <input type="checkbox" checked={includeMissions} onChange={(e) => setIncludeMissions(e.target.checked)} className="accent-orange-400" />
            Also recall the {onMissions} arm{onMissions === 1 ? "y" : "ies"} on missions (they return to where they left from; rally again when home)
          </label>
          <span className="flex gap-2">
            <Button variant="primary" disabled={m.isPending || (stationed === 0 && !(includeMissions && onMissions > 0))} onClick={() => m.mutate()}>
              Rally
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </span>
          {m.data && (
            <span className="block text-emerald-400">
              {m.data.soldiers} soldiers in {m.data.groups} groups on their way{m.data.recalled ? `, ${m.data.recalled} armies recalled` : ""}.{m.data.skipped.length ? ` Skipped: ${m.data.skipped.join("; ")}` : ""}
            </span>
          )}
          <ErrorText>{m.error?.message}</ErrorText>
        </span>
      )}
    </span>
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
                <JobTime startsAt={j.startsAt} endsAt={j.endsAt} clockOffsetMs={clockOffsetMs} />
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
  return AGES[age as AgeIndex] ?? "Unknown";
}
