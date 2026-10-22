import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { buildingById, regionById, techById, unitById, type MatchStateView, missionLabel } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Card, CardHeader } from "./ui.js";
import { Countdown, JobTime } from "./Countdown.js";

/**
 * Everything in progress, always visible at the top of the side panel:
 * builds and trainings per region, the research queue, and armies in flight.
 */
export function ActivityPanel({ matchId, state, clockOffsetMs, onSelect }: { matchId: string; state: MatchStateView; clockOffsetMs: number; onSelect: (regionId: string) => void }) {
  const qc = useQueryClient();
  const cancel = useMutation({ mutationFn: (jobId: string) => api.cancelJob(matchId, jobId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  const recall = useMutation({ mutationFn: (armyId: string) => api.recallArmy(matchId, armyId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  const now = Date.now() + clockOffsetMs;
  const jobs = [...state.jobs].sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
  const research = jobs.filter((j) => j.kind === "research");
  const work = jobs.filter((j) => j.kind === "build" || j.kind === "train");
  const armies = state.armies;
  // Group moving units by what they are and whether they are heading out or home.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) => setOpenGroups((o) => ({ ...o, [key]: !(o[key] ?? false) }));
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; items: Array<{ army: MatchStateView["armies"][number]; dest: string; to: string; note: string }> }>();
    for (const a of armies) {
      const returning = a.status === "returning";
      const base = missionLabel(a.mission, a.units);
      const key = `${base}:${returning ? "back" : "out"}`;
      const label = returning ? `${base} returning` : base;
      const dest = regionById(returning ? a.originRegionId : a.targetRegionId)?.name ?? "";
      const to = returning ? (a.returnsAt ?? a.arrivesAt) : a.arrivesAt;
      const units = Object.entries(a.units)
        .filter(([, n]) => n > 0)
        .map(([id, n]) => `${n} ${unitById.get(id)?.name ?? id}`)
        .join(", ");
      const goods = Object.entries(a.cargo)
        .filter(([k, n]) => k !== "people" && n > 0)
        .map(([k, n]) => `${Math.round(n)} ${k}`)
        .join(", ");
      const note = [units, goods].filter(Boolean).join(" · ") || "no units";
      const g = map.get(key) ?? { key, label, items: [] };
      g.items.push({ army: a, dest, to, note });
      map.set(key, g);
    }
    const out = [...map.values()];
    for (const g of out) g.items.sort((x, y) => Date.parse(x.to) - Date.parse(y.to));
    return out.sort((x, y) => Date.parse(x.items[0]!.to) - Date.parse(y.items[0]!.to));
  }, [armies]);
  const total = research.length + work.length + armies.length;

  const label = (j: MatchStateView["jobs"][number]) =>
    j.kind === "build"
      ? `${buildingById.get(j.refId ?? "")?.name ?? j.refId} lvl ${j.level}`
      : j.kind === "train"
        ? `${j.qty} ${unitById.get(j.refId ?? "")?.name ?? j.refId}`
        : (techById.get(j.refId ?? "")?.name ?? j.refId ?? "");

  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("lt_inprogress_open") !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem("lt_inprogress_open", o ? "0" : "1");
      } catch {
        // ignore
      }
      return !o;
    });
  };
  // Collapsed: just the header with the count and the soonest completion.
  const next = [...research, ...work].sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))[0];

  return (
    <Card className="space-y-1 border-sky-500/30">
      <CardHeader>
      <button type="button" onClick={toggle} className="flex w-full items-center justify-between text-left" aria-expanded={open}>
        <h2 className="text-sm font-medium">
          <span className="mr-1 inline-block w-3 text-slate-500">{open ? "▾" : "▸"}</span>In progress
        </h2>
        <span className="flex items-center gap-2 text-xs text-slate-300">
          {!open && next && (
            <span className="text-slate-400">
              next: {label(next)} <Countdown to={next.endsAt} clockOffsetMs={clockOffsetMs} />
            </span>
          )}
          <span className="rounded bg-slate-800 px-1.5 py-0.5">{total}</span>
        </span>
      </button>
      </CardHeader>
      {!open ? null : (
        <>
      {total === 0 && <p className="text-xs text-slate-400">Nothing is building, training or researching. Pick a region to start something.</p>}
      {research.length > 0 && (
        <Section title="Research">
          {research.map((j, i) => (
            <Row key={j.id} name={label(j)} note={i > 0 ? "queued" : ""} to={j.endsAt} startsAt={j.startsAt} clockOffsetMs={clockOffsetMs} waiting={Date.parse(j.startsAt) > now} onCancel={() => cancel.mutate(j.id)} />
          ))}
        </Section>
      )}
      {work.length > 0 && (
        <Section title="Building and training">
          {work.map((j) => (
            <Row
              key={j.id}
              name={label(j)}
              note={`${regionById(j.regionId ?? "")?.name ?? ""}${j.waitingFor ? ` · waiting for ${Object.entries(j.waitingFor).map(([k, v]) => `${Math.round(v)} ${k}`).join(", ")} by caravan` : ""}`}
              to={j.endsAt}
              clockOffsetMs={clockOffsetMs}
              waiting={Date.parse(j.startsAt) > now}
              startsAt={j.startsAt}
              status={j.waitingFor ? "materials" : undefined}
              onCancel={() => cancel.mutate(j.id)}
              onClick={j.regionId ? () => onSelect(j.regionId!) : undefined}
            />
          ))}
        </Section>
      )}
      {armies.length > 0 && (
        <Section title="On the move">
          {groups.map((g) => {
            const isOpen = openGroups[g.key] ?? g.items.length <= 2;
            const soonest = g.items[0]!;
            return (
              <li key={g.key} className="text-sm">
                <button type="button" onClick={() => toggleGroup(g.key)} className="flex w-full items-center gap-2 text-left hover:text-white" aria-expanded={isOpen}>
                  <span className="inline-block w-3 text-slate-500">{isOpen ? "▾" : "▸"}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {g.label} <span className="text-slate-500">× {g.items.length}</span>
                  </span>
                  {!isOpen && (
                    <span className="shrink-0 text-xs text-slate-500">
                      next <Countdown to={soonest.to} clockOffsetMs={clockOffsetMs} />
                    </span>
                  )}
                </button>
                {isOpen && (
                  <ul className="ml-5 space-y-0.5 border-l border-slate-800 pl-2">
                    {g.items.map((it) => (
                      <Row
                        key={it.army.id}
                        name={`${it.army.status === "returning" ? "returning to" : "→"} ${it.dest}${it.army.status === "returning" && it.army.note ? ` (${it.army.note})` : ""}`}
                        note={it.note}
                        to={it.to}
                        clockOffsetMs={clockOffsetMs}
                        onClick={() => onSelect(it.army.targetRegionId)}
                        onCancel={it.army.status === "outbound" ? () => recall.mutate(it.army.id) : undefined}
                        cancelTitle="Recall: turn around and come home"
                      />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </Section>
      )}
        </>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-slate-500">{title}</p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function Row({ name, note, to, clockOffsetMs, waiting, onCancel, onClick, cancelTitle = "Cancel", status, startsAt }: { name: string; note: string; to: string; clockOffsetMs: number; waiting?: boolean | undefined; onCancel?: (() => void) | undefined; onClick?: (() => void) | undefined; cancelTitle?: string; status?: string | undefined; startsAt?: string | undefined }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <button className={`min-w-0 flex-1 truncate text-left ${onClick ? "hover:text-white" : "cursor-default"}`} onClick={onClick}>
        {name}
        {note && <span className="ml-1 text-xs text-slate-500">{note}</span>}
      </button>
      <span className={`tabular-nums ${waiting ? "text-slate-500" : "text-sky-300"}`}>
        {status ? <span className="text-xs text-amber-300">{status}</span> : startsAt ? <JobTime startsAt={startsAt} endsAt={to} clockOffsetMs={clockOffsetMs} /> : <Countdown to={to} clockOffsetMs={clockOffsetMs} />}
      </span>
      {onCancel && (
        <button className="text-xs text-slate-600 hover:text-rose-400" onClick={onCancel} title={cancelTitle}>
          {cancelTitle.startsWith("Recall") ? "↩" : "✕"}
        </button>
      )}
    </li>
  );
}
