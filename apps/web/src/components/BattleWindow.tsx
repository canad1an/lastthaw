import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { balance, formatCountdown, regionById, unitById, type BattleDetailView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { useNow } from "../hooks/useNow.js";
import { unitGlyph } from "./unitGlyphs.js";

const total = (u: Record<string, number>) => Object.values(u).reduce((a, b) => a + b, 0);
const strengthOf = (u: Record<string, number>, stat: "attack" | "defense") => Object.entries(u).reduce((a, [id, n]) => a + n * (unitById.get(id)?.[stat] ?? 0), 0);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * The live battle: both armies on a mock battlefield, a unit per tile and the fallen greyed out, the strength of each
 * side, what the defender has going for it, a countdown to the next round and a log of the rounds so far. It follows
 * the battle over the websocket (battle.round events refetch it) with a slow poll behind.
 */
export function BattleWindow({ matchId, battleId, myPlayerId, onClose, onSelectRegion }: { matchId: string; battleId: string; myPlayerId: string | null; onClose: () => void; onSelectRegion: (regionId: string) => void }) {
  const q = useQuery({ queryKey: keys.battle(matchId, battleId), queryFn: () => api.battle(matchId, battleId), refetchInterval: (query) => (query.state.data?.status === "fighting" ? 5000 : false) });
  const now = useNow(500);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const b = q.data;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/85 p-3 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label="Battle">
      <div className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-rose-500/40 bg-slate-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {!b ? (
          <p className="p-6 text-sm text-slate-400">{q.error ? q.error.message : "Loading the battle…"}</p>
        ) : (
          <Battle b={b} now={now} myPlayerId={myPlayerId} onClose={onClose} onSelectRegion={onSelectRegion} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function Battle({ b, now, myPlayerId, onClose, onSelectRegion }: { b: BattleDetailView; now: number; myPlayerId: string | null; onClose: () => void; onSelectRegion: (regionId: string) => void }) {
  const fighting = b.status === "fighting";
  const next = b.nextRoundAt ? (Date.parse(b.nextRoundAt) - now) / 1000 : 0;
  const region = regionById(b.regionId)?.name ?? b.regionId;
  const aStart = total(b.attacker.start);
  const dStart = total(b.defender.start);
  const aNow = total(b.attacker.now);
  const dNow = total(b.defender.now);
  const you = (id: string | null) => (id && id === myPlayerId ? " (you)" : "");
  const verdict = b.result ? (b.result.conquered ? `${b.attacker.name} took ${region}.` : b.result.attackerWon ? `${b.attacker.name} won the field${b.mission === "raid" ? " and carried off the loot" : ""}.` : `${b.defender.name} held ${region}.`) : null;
  return (
    <>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-800 px-4 py-3">
        <h2 className="text-base font-semibold text-white">
          {b.mission === "raid" ? "Raid on" : "Battle for"}{" "}
          <button className="underline decoration-slate-600 hover:text-sky-200" onClick={() => onSelectRegion(b.regionId)}>
            {region}
          </button>
        </h2>
        <span className="text-xs text-slate-400">
          {b.attacker.name}
          {you(b.attackerPlayerId)} against {b.defender.name}
          {you(b.defenderPlayerId)}
        </span>
        <span className="ml-auto rounded bg-slate-800 px-2 py-0.5 text-xs tabular-nums text-slate-200">
          {fighting ? `Round ${b.round} of ${b.totalRounds}${next > 0 ? ` · next in ${Math.ceil(next)}s` : " · …"}` : `Over after ${b.totalRounds} round${b.totalRounds === 1 ? "" : "s"}`}
        </span>
        <button className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {verdict && <p className={`mb-3 rounded px-3 py-2 text-sm ${b.result?.attackerWon ? "bg-rose-500/15 text-rose-100" : "bg-emerald-500/15 text-emerald-100"}`}>{verdict}</p>}
        <div className="grid gap-3 md:grid-cols-2">
          <Side label="Attackers" name={b.attacker.name} units={b.attacker.now} start={b.attacker.start} now={aNow} total={aStart} strength={strengthOf(b.attacker.now, "attack") * (1 + b.bonus.attack)} strengthLabel="attack" tone="rose" chips={[b.bonus.attack ? `techs +${pct(b.bonus.attack)}` : "", b.bonus.siege ? `siege ${b.bonus.siege}` : ""].filter(Boolean)} />
          <Side label="Defenders" name={b.defender.name} units={b.defender.now} start={b.defender.start} now={dNow} total={dStart} strength={strengthOf(b.defender.now, "defense") * (1 + b.bonus.defense)} strengthLabel="defence" tone="sky" chips={[b.bonus.wallFull ? `walls +${pct(b.bonus.wallBonus)}${b.bonus.wallBonus < b.bonus.wallFull ? ` (breached from +${pct(b.bonus.wallFull)})` : ""}` : "no wall", b.bonus.terrain ? `terrain +${pct(b.bonus.terrain)}` : "", b.bonus.militia ? `${b.bonus.militia} militia` : ""].filter(Boolean)} />
        </div>
        <div className="mt-3">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">The rounds</p>
          <ol className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-slate-800 bg-slate-900/50 p-2 text-xs text-slate-300">
            {b.log.length === 0 && <li className="text-slate-500">{fighting ? "The lines are forming…" : "Nobody fell."}</li>}
            {[...b.log].reverse().map((r) => (
              <li key={r.round} className="flex gap-2">
                <span className="w-16 shrink-0 tabular-nums text-slate-500">Round {r.round}</span>
                <span>{describeRound(r.aLoss, r.dLoss, b.attacker.name, b.defender.name)}</span>
              </li>
            ))}
          </ol>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">The result was decided when the army arrived, by the usual rules; the fight plays out a unit or two every {balance.battle.roundSeconds} seconds so you can watch it. Nothing changes hands until the last round.</p>
      </div>
    </>
  );
}

function describeRound(aLoss: Record<string, number>, dLoss: Record<string, number>, attacker: string, defender: string): string {
  const say = (u: Record<string, number>, who: string) =>
    Object.entries(u)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${n === 1 ? "a" : n} ${unitById.get(id)?.name ?? id}${n === 1 ? "" : "s"} of ${who}'s fell`)
      .join(", ");
  const parts = [say(aLoss, attacker), say(dLoss, defender)].filter(Boolean);
  return parts.length ? parts.join("; ") + "." : "nobody fell.";
}

/** One side of the field: a tile per unit, the fallen greyed, with the side's strength bar and what helps it. */
function Side({ label, name, units, start, now, total, strength, strengthLabel, tone, chips }: { label: string; name: string; units: Record<string, number>; start: Record<string, number>; now: number; total: number; strength: number; strengthLabel: string; tone: "rose" | "sky"; chips: string[] }) {
  const colour = tone === "rose" ? "bg-rose-500" : "bg-sky-500";
  const types = Object.entries(start)
    .filter(([, n]) => n > 0)
    .sort((x, y) => (unitById.get(y[0])?.attack ?? 0) + (unitById.get(y[0])?.defense ?? 0) - (unitById.get(x[0])?.attack ?? 0) - (unitById.get(x[0])?.defense ?? 0));
  return (
    <section className={`rounded-xl border p-3 ${tone === "rose" ? "border-rose-500/30 bg-rose-950/10" : "border-sky-500/30 bg-sky-950/10"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">
          {label} <span className="font-normal text-slate-400">· {name}</span>
        </h3>
        <span className="text-xs tabular-nums text-slate-300">
          {now} of {total} standing
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded bg-slate-800">
        <div className={`h-full ${colour} transition-all duration-700`} style={{ width: `${total ? (now / total) * 100 : 0}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        {strengthLabel} {Math.round(strength).toLocaleString("en-US")}
        {chips.length ? ` · ${chips.join(" · ")}` : ""}
      </p>
      <div className="mt-2 space-y-2">
        {types.map(([id, n]) => {
          const alive = units[id] ?? 0;
          const shown = Math.min(n, 40);
          const def = unitById.get(id);
          return (
            <div key={id}>
              <p className="text-[11px] text-slate-300">
                {alive} of {n} {def?.name ?? id}
                {n === 1 ? "" : "s"}
                {n - alive > 0 ? <span className="text-slate-500"> · {n - alive} fallen</span> : null}
              </p>
              <div className="mt-0.5 flex flex-wrap gap-0.5">
                {Array.from({ length: shown }, (_, i) => {
                  // The fallen are the last tiles of the row, so a line of men thins from the right.
                  const fallen = i >= Math.round((alive / n) * shown);
                  return (
                    <span key={i} className={`flex h-6 w-6 items-center justify-center rounded text-sm leading-none transition-opacity duration-700 ${fallen ? "bg-slate-900 opacity-30 grayscale" : tone === "rose" ? "bg-rose-900/40" : "bg-sky-900/40"}`} title={def?.name ?? id}>
                      {unitGlyph(id)}
                    </span>
                  );
                })}
                {n > shown && <span className="self-center pl-1 text-[11px] text-slate-500">×{n}</span>}
              </div>
            </div>
          );
        })}
        {types.length === 0 && <p className="text-xs text-slate-500">nobody</p>}
      </div>
    </section>
  );
}
