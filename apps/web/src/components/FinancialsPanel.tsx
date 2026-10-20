import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { balance, type FinanceView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { fmt } from "./ui.js";

const RES = ["food", "wood", "stone", "copper", "tin", "iron", "horses"] as const;
type Res = (typeof RES)[number];
const CATEGORIES: ReadonlyArray<{ id: string; label: string; colour: string }> = [
  { id: "build", label: "Buildings", colour: "#38bdf8" },
  { id: "military", label: "Military", colour: "#f43f5e" },
  { id: "soldiers", label: "Soldiers' food", colour: "#fb7185" },
  { id: "people", label: "People's food", colour: "#fbbf24" },
  { id: "research", label: "Research", colour: "#a78bfa" },
  { id: "advisors", label: "Advisors", colour: "#34d399" },
  { id: "market", label: "Market", colour: "#f59e0b" },
  { id: "tribute", label: "Tribute", colour: "#94a3b8" },
  { id: "refugees", label: "Refugees", colour: "#c084fc" },
];
const colourOf = (id: string) => CATEGORIES.find((c) => c.id === id)?.colour ?? "#64748b";
const labelOf = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? id;

/**
 * The books: what the empire gathers and mines per hour now and over the match, against what it spends by category
 * (buildings, military, research, advisors, market, tribute, refugees) and what its people and soldiers eat. One
 * resource at a time, with a summary of every resource for the last day underneath.
 */
export function FinancialsPanel({ matchId }: { matchId: string }) {
  const q = useQuery({ queryKey: keys.finance(matchId), queryFn: () => api.finance(matchId), refetchInterval: 30_000 });
  const [res, setRes] = useState<Res>("food");
  const f = q.data;
  const model = useMemo(() => (f ? build(f, res) : null), [f, res]);
  if (!f || !model) return <p className="p-3 text-xs text-slate-400">{q.error ? q.error.message : "Adding up the books…"}</p>;
  const today = Math.floor(f.day);
  const hoursToday = Math.max(0.01, (f.day - today) * 24);
  return (
    <div className="space-y-3 p-3 text-sm">
      <div className="flex flex-wrap gap-1">
        {RES.filter((r) => (f.now.gross[r] ?? 0) > 0 || f.spending.some((s) => s.resource === r) || r === "food" || r === "wood" || r === "stone").map((r) => (
          <button key={r} className={`rounded-full px-2.5 py-0.5 text-xs capitalize ${r === res ? "bg-sky-500/20 text-sky-100 ring-1 ring-sky-400/60" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`} onClick={() => setRes(r)}>
            {r}
          </button>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <Stat label={`${res} gathered per hour`} value={fmt(Math.round(model.grossNow))} hint={`${f.now.regions} region${f.now.regions === 1 ? "" : "s"}`} />
        {res === "food" ? (
          <Stat label="eaten per hour" value={fmt(Math.round(f.now.eaten.people + f.now.eaten.soldiers))} hint={`people ${fmt(Math.round(f.now.eaten.people))}, soldiers ${fmt(Math.round(f.now.eaten.soldiers))}`} tone={f.now.eaten.people + f.now.eaten.soldiers > model.grossNow ? "bad" : undefined} />
        ) : (
          <Stat label="spent today" value={fmt(Math.round(model.spentToday))} hint={`over ${hoursToday.toFixed(1)} h of day ${today + 1}`} />
        )}
        <Stat label={res === "food" ? "spent today" : "kept per hour, today"} value={res === "food" ? fmt(Math.round(model.spentToday)) : fmt(Math.round(model.grossNow - model.spentToday / hoursToday))} hint={res === "food" ? `over ${hoursToday.toFixed(1)} h of day ${today + 1}` : "gathered less spending, averaged over today"} tone={res !== "food" && model.grossNow - model.spentToday / hoursToday < 0 ? "bad" : undefined} />
      </div>

      <section>
        <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">{res} per hour, over the match</p>
        <LineChart series={model.lines} maxDay={Math.max(1, f.day)} unit="/h" />
      </section>

      <section>
        <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">{res} spent, by day and by what</p>
        <BarChart days={model.days} maxDay={Math.max(1, f.day)} />
      </section>

      <section>
        <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Every resource, the last day</p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-normal">resource</th>
              <th className="py-1 text-right font-normal">gathered</th>
              <th className="py-1 text-right font-normal">eaten</th>
              <th className="py-1 text-right font-normal">spent</th>
              <th className="py-1 text-right font-normal">kept</th>
            </tr>
          </thead>
          <tbody>
            {RES.filter((r) => (f.now.gross[r] ?? 0) > 0 || model.lastDaySpent[r]).map((r) => {
              const gathered = (f.now.gross[r] ?? 0) * 24;
              const eaten = r === "food" ? (f.now.eaten.people + f.now.eaten.soldiers) * 24 : 0;
              const spent = model.lastDaySpent[r] ?? 0;
              const kept = gathered - eaten - spent;
              return (
                <tr key={r} className="border-t border-slate-800">
                  <td className="py-1 capitalize text-slate-200">{r}</td>
                  <td className="py-1 text-right tabular-nums text-slate-300">{fmt(Math.round(gathered))}</td>
                  <td className="py-1 text-right tabular-nums text-slate-300">{eaten ? fmt(Math.round(eaten)) : "–"}</td>
                  <td className="py-1 text-right tabular-nums text-slate-300">{spent ? fmt(Math.round(spent)) : "–"}</td>
                  <td className={`py-1 text-right tabular-nums ${kept < 0 ? "text-rose-300" : "text-emerald-300"}`}>{fmt(Math.round(kept))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-1 text-[11px] text-slate-500">Gathered and eaten are today's rates over 24 hours; spent is the last 24 game hours of the books. Advisors take {Math.round(balance.advisors.outputShare * 100)}% of what you gather each, so with four hired the kept column goes to zero.</p>
      </section>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string | undefined; tone?: "bad" | undefined }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tone === "bad" ? "text-rose-300" : "text-white"}`}>{value}</p>
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

interface Series {
  id: string;
  label: string;
  colour: string;
  points: Array<{ x: number; y: number }>;
  dashed?: boolean;
}

function build(f: FinanceView, res: Res) {
  const grossNow = f.now.gross[res] ?? 0;
  const today = Math.floor(f.day);
  const spentToday = f.spending.filter((s) => s.resource === res && s.day === today).reduce((a, s) => a + s.amount, 0);
  // Lines: gathered per hour from the samples, with now appended; for food, what is eaten too.
  const gathered = f.history.map((h) => ({ x: h.day, y: h.gross[res] ?? 0 }));
  gathered.push({ x: f.day, y: grossNow });
  const lines: Series[] = [{ id: "gross", label: "gathered", colour: "#34d399", points: gathered }];
  if (res === "food") {
    const eaten = f.history.map((h) => ({ x: h.day, y: h.eaten.people + h.eaten.soldiers }));
    eaten.push({ x: f.day, y: f.now.eaten.people + f.now.eaten.soldiers });
    lines.push({ id: "eaten", label: "eaten", colour: "#fb7185", points: eaten, dashed: true });
  }
  // Bars: spent per day by category, with what soldiers and people ate (from the samples of that day) for food.
  const days = new Map<number, Record<string, number>>();
  for (const s of f.spending) {
    if (s.resource !== res || s.amount <= 0) continue;
    const d = days.get(s.day) ?? {};
    d[s.category] = (d[s.category] ?? 0) + s.amount;
    days.set(s.day, d);
  }
  if (res === "food") {
    const byDay = new Map<number, Array<FinanceView["history"][number]>>();
    for (const h of f.history) byDay.set(Math.floor(h.day), [...(byDay.get(Math.floor(h.day)) ?? []), h]);
    for (const [dayN, samples] of byDay) {
      const hours = dayN === today ? (f.day - today) * 24 : 24;
      const avg = (k: "people" | "soldiers") => samples.reduce((a, h) => a + h.eaten[k], 0) / samples.length;
      const d = days.get(dayN) ?? {};
      d.people = avg("people") * hours;
      d.soldiers = avg("soldiers") * hours;
      days.set(dayN, d);
    }
  }
  const lastDaySpent: Record<string, number> = {};
  for (const s of f.spending) if (s.day >= today - 1 && s.amount > 0 && s.day + 1 >= f.day - 1) lastDaySpent[s.resource] = (lastDaySpent[s.resource] ?? 0) + s.amount;
  return { grossNow, spentToday, lines, days: [...days.entries()].sort((a, b) => a[0] - b[0]), lastDaySpent };
}

/** A small line chart: days along the bottom, the unit up the side, one path per series. */
function LineChart({ series, maxDay, unit }: { series: Series[]; maxDay: number; unit: string }) {
  const W = 640;
  const H = 180;
  const padL = 46;
  const padB = 20;
  const padT = 8;
  const top = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.y))) * 1.05;
  const x = (d: number) => padL + (d / maxDay) * (W - padL - 8);
  const y = (v: number) => padT + (1 - v / top) * (H - padT - padB);
  const dayTicks = Array.from({ length: Math.floor(maxDay) + 1 }, (_, i) => i).filter((d) => maxDay <= 10 || d % 5 === 0);
  const any = series.some((s) => s.points.length > 1);
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/40 p-2">
      {!any && <p className="mb-1 text-[11px] text-slate-500">The first samples arrive as the match goes on; the line starts from now.</p>}
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Production over time">
        {[0, 0.5, 1].map((fr) => (
          <g key={fr}>
            <line x1={padL} x2={W - 8} y1={y(top * fr)} y2={y(top * fr)} stroke="#1e293b" strokeWidth={1} />
            <text x={padL - 4} y={y(top * fr)} textAnchor="end" dominantBaseline="central" fontSize={9} fill="#64748b">
              {fmt(Math.round(top * fr))}
              {unit}
            </text>
          </g>
        ))}
        {dayTicks.map((d) => (
          <text key={d} x={x(d)} y={H - 6} textAnchor="middle" fontSize={9} fill="#64748b">
            day {d + 1}
          </text>
        ))}
        {series.map((s) => {
          const pts = [...s.points].sort((a, b) => a.x - b.x);
          const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.x).toFixed(1)} ${y(p.y).toFixed(1)}`).join(" ");
          return <path key={s.id} d={d} fill="none" stroke={s.colour} strokeWidth={2.2} strokeDasharray={s.dashed ? "5 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />;
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {series.map((s) => (
          <span key={s.id} className="flex items-center gap-1 text-slate-300">
            <span className="inline-block h-0.5 w-4" style={{ background: s.colour }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Stacked bars: one per game day, a colour per category. */
function BarChart({ days, maxDay }: { days: Array<[number, Record<string, number>]>; maxDay: number }) {
  const W = 640;
  const H = 180;
  const padL = 46;
  const padB = 20;
  const padT = 8;
  const n = Math.max(1, Math.floor(maxDay) + 1);
  const top = Math.max(1, ...days.map(([, d]) => Object.values(d).reduce((a, b) => a + b, 0))) * 1.05;
  const slot = (W - padL - 8) / n;
  const bw = Math.max(2, slot * 0.7);
  const y = (v: number) => padT + (1 - v / top) * (H - padT - padB);
  const used = new Set(days.flatMap(([, d]) => Object.keys(d).filter((k) => d[k]! > 0)));
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/40 p-2">
      {days.length === 0 && <p className="mb-1 text-[11px] text-slate-500">Nothing spent yet.</p>}
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Spending by day">
        {[0, 0.5, 1].map((fr) => (
          <g key={fr}>
            <line x1={padL} x2={W - 8} y1={y(top * fr)} y2={y(top * fr)} stroke="#1e293b" strokeWidth={1} />
            <text x={padL - 4} y={y(top * fr)} textAnchor="end" dominantBaseline="central" fontSize={9} fill="#64748b">
              {fmt(Math.round(top * fr))}
            </text>
          </g>
        ))}
        {Array.from({ length: n }, (_, i) => i)
          .filter((d) => n <= 10 || d % 5 === 0)
          .map((d) => (
            <text key={d} x={padL + slot * d + slot / 2} y={H - 6} textAnchor="middle" fontSize={9} fill="#64748b">
              day {d + 1}
            </text>
          ))}
        {days.map(([day, d]) => {
          let acc = 0;
          return CATEGORIES.filter((c) => (d[c.id] ?? 0) > 0).map((c) => {
            const v = d[c.id]!;
            const y1 = y(acc + v);
            const h = y(acc) - y1;
            acc += v;
            return <rect key={`${day}-${c.id}`} x={padL + slot * day + (slot - bw) / 2} y={y1} width={bw} height={Math.max(0.5, h)} fill={c.colour} opacity={0.9}>
              <title>{`day ${day + 1}: ${labelOf(c.id)} ${fmt(Math.round(v))}`}</title>
            </rect>;
          });
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {CATEGORIES.filter((c) => used.has(c.id)).map((c) => (
          <span key={c.id} className="flex items-center gap-1 text-slate-300">
            <span className="inline-block h-2 w-4 rounded-sm" style={{ background: colourOf(c.id) }} />
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
