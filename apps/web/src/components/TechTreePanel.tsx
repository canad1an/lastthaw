import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { AGES, TECHS, type AgeIndex, availableTechs, formatCountdown, matchDayOf, realSeconds, techById, techCost, techSeconds, type MatchStateView, type TechDef } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { CostLine } from "./Countdown.js";
import { Button, ErrorText } from "./ui.js";
import { techPreview } from "./previews.js";

type Status = "done" | "queued" | "available" | "locked";

/**
 * The whole tech tree, one column per age: what is done, what can be
 * researched now, what it costs and gives, and what still locks the rest.
 */
export function TechTreePanel({ matchId, state, clockOffsetMs }: { matchId: string; state: MatchStateView; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const day = matchDayOf(state, clockOffsetMs);
  const done = useMemo(() => new Set(state.me.techs), [state.me.techs]);
  const queued = useMemo(() => new Set(state.jobs.filter((j) => j.kind === "research").map((j) => j.refId ?? "")), [state.jobs]);
  const known = useMemo(() => new Set([...done, ...queued]), [done, queued]);
  const available = useMemo(() => new Set(availableTechs(state.me.age, known).map((t) => t.id)), [state.me.age, known]);
  const capital = state.owned.find((o) => o.isCapital) ?? state.owned[0] ?? null;
  const pooled = useMemo(() => {
    const s: Record<string, number> = capital ? { food: capital.food, wood: capital.wood, stone: capital.stone } : {};
    for (const o of state.owned) if (!o.frozen) for (const [k, v] of Object.entries(o.special)) s[k] = (s[k] ?? 0) + v;
    return s;
  }, [state.owned, capital]);
  const research = useMutation({
    mutationFn: (techId: string) => api.research(matchId, techId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  const statusOf = (t: TechDef): Status => (done.has(t.id) ? "done" : queued.has(t.id) ? "queued" : available.has(t.id) ? "available" : "locked");
  const byAge = AGES.map((name, i) => ({ name, i, techs: TECHS.filter((t) => t.age === i) }));
  const doneCount = TECHS.filter((t) => done.has(t.id)).length;

  return (
    <div className="max-h-[70vh] overflow-auto p-3 text-sm">
      <p className="mb-2 text-xs text-slate-400">
        {doneCount} of {TECHS.length} techs researched · {AGES[state.me.age as AgeIndex] ?? "Unknown"} Age · day {Math.floor(day) + 1}. Ages have an earliest day; everything else needs only its prerequisites and the resources.
      </p>
      <div className="flex min-w-max gap-3">
        {byAge.map((col) => (
          <div key={col.i} className={`w-64 shrink-0 rounded-md border p-2 ${col.i === state.me.age ? "border-sky-500/40 bg-sky-500/5" : col.i < state.me.age ? "border-slate-800 bg-slate-900/40" : "border-slate-800"}`}>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              {col.name} Age {col.i < state.me.age ? "· past" : col.i === state.me.age ? "· now" : ""}
            </h3>
            <ul className="space-y-1.5">
              {col.techs.map((t) => {
                const st = statusOf(t);
                const cost = techCost(t, day);
                const secs = capital ? realSeconds(techSeconds(t), capital.effects.researchSpeed, state.match.speed) : techSeconds(t);
                const locked = t.earliestDay !== undefined && day < t.earliestDay;
                const { unlocks } = techPreview(t);
                const missing = (t.requires ?? []).filter((r) => !done.has(r));
                return (
                  <li key={t.id} className={`rounded border p-1.5 text-xs ${st === "done" ? "border-emerald-700/40 bg-emerald-900/10" : st === "queued" ? "border-sky-700/40 bg-sky-900/10" : st === "available" ? "border-slate-700 bg-slate-900" : "border-slate-800/60 text-slate-500"}`}>
                    <div className="flex items-start justify-between gap-1">
                      <span className={st === "locked" ? "" : "text-slate-100"}>
                        {t.name}
                        {t.advancesTo !== undefined && <span className="ml-1 rounded bg-amber-500/20 px-1 text-[10px] text-amber-300">→ {AGES[t.advancesTo]}</span>}
                      </span>
                      <span className={`shrink-0 text-[10px] ${st === "done" ? "text-emerald-400" : st === "queued" ? "text-sky-300" : st === "available" ? "text-slate-400" : "text-slate-600"}`}>
                        {st === "done" ? "done" : st === "queued" ? "queued" : st === "available" ? (locked ? `from day ${t.earliestDay! + 1}` : formatCountdown(secs)) : missing.length ? `needs ${missing.map((r) => techById.get(r)?.name ?? r).join(", ")}` : col.i > state.me.age ? "later age" : "locked"}
                      </span>
                    </div>
                    {st !== "done" && (
                      <p className="mt-0.5">
                        <CostLine cost={cost} stock={pooled} />
                      </p>
                    )}
                    {unlocks.length > 0 && <p className="mt-0.5 text-slate-500">{unlocks.join(" · ")}</p>}
                    {st === "available" && !locked && (
                      <Button variant="ghost" disabled={research.isPending} onClick={() => research.mutate(t.id)}>
                        Research
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <ErrorText>{research.error?.message}</ErrorText>
    </div>
  );
}
