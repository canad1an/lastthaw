import { useMemo } from "react";
import { missionLabel, regionById, unitById, type MatchStateView } from "@lastthaw/shared";
import { fmt } from "./ui.js";

const RES = ["food", "wood", "stone", "copper", "tin", "iron", "horses"] as const;

/**
 * Everything you have, in one table: every region's people, stores and
 * stationed units, with totals, plus units on the move.
 */
export function EmpirePanel({ state, onSelect }: { state: MatchStateView; onSelect: (regionId: string) => void }) {
  const rows = useMemo(
    () =>
      [...state.owned]
        .sort((a, b) => (a.isCapital ? -1 : b.isCapital ? 1 : (regionById(a.regionId)?.name ?? "").localeCompare(regionById(b.regionId)?.name ?? "")))
        .map((o) => ({
          id: o.regionId,
          name: regionById(o.regionId)?.name ?? o.regionId,
          capital: o.isCapital,
          frozen: o.frozen,
          people: o.popWorkers + o.popSoldiers + o.popOccupiers,
          res: Object.fromEntries(RES.map((r) => [r, r === "food" || r === "wood" || r === "stone" ? o[r] : (o.special[r] ?? 0)])) as Record<(typeof RES)[number], number>,
          units: Object.entries(o.units).filter(([, n]) => n > 0),
        })),
    [state.owned],
  );
  const unitIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of rows) for (const [id] of r.units) ids.add(id);
    for (const a of state.armies) for (const [id, n] of Object.entries(a.units)) if (n > 0) ids.add(id);
    return [...ids].sort((a, b) => (unitById.get(a)?.age ?? 0) - (unitById.get(b)?.age ?? 0) || a.localeCompare(b));
  }, [rows, state.armies]);
  const totals = useMemo(() => {
    const t = { people: 0, res: Object.fromEntries(RES.map((r) => [r, 0])) as Record<(typeof RES)[number], number>, units: {} as Record<string, number> };
    for (const r of rows) {
      t.people += r.people;
      for (const k of RES) t.res[k] += r.res[k];
      for (const [id, n] of r.units) t.units[id] = (t.units[id] ?? 0) + n;
    }
    return t;
  }, [rows]);
  const moving = useMemo(() => {
    const u: Record<string, number> = {};
    const cargo: Record<string, number> = {};
    for (const a of state.armies) {
      for (const [id, n] of Object.entries(a.units)) if (n > 0) u[id] = (u[id] ?? 0) + n;
      for (const [k, n] of Object.entries(a.cargo)) if (n > 0 && k !== "people") cargo[k] = (cargo[k] ?? 0) + n;
    }
    return { units: u, cargo };
  }, [state.armies]);
  const shownRes = RES.filter((r) => r === "food" || r === "wood" || r === "stone" || totals.res[r] > 0 || (moving.cargo[r] ?? 0) > 0);

  return (
    <div className="max-h-[70vh] overflow-auto p-3 text-sm">
      <table className="w-full min-w-max border-collapse text-xs">
        <thead className="sticky top-0 bg-slate-950 text-slate-400">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Region</th>
            <th className="px-2 py-1 text-right font-medium">People</th>
            {shownRes.map((r) => (
              <th key={r} className="px-2 py-1 text-right font-medium capitalize">
                {r}
              </th>
            ))}
            {unitIds.map((id) => (
              <th key={id} className="px-2 py-1 text-right font-medium">
                {unitById.get(id)?.name ?? id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const units = Object.fromEntries(r.units);
            return (
              <tr key={r.id} className={`border-t border-slate-900 hover:bg-slate-900 ${r.frozen ? "text-slate-500" : "text-slate-200"}`}>
                <td className="px-2 py-1">
                  <button className="text-left hover:text-white" onClick={() => onSelect(r.id)}>
                    {r.name}
                    {r.capital ? <span className="ml-1 rounded bg-sky-500/20 px-1 text-[10px] text-sky-300">capital</span> : null}
                    {r.frozen ? <span className="ml-1 rounded bg-cyan-200/20 px-1 text-[10px] text-cyan-200">frozen</span> : null}
                  </button>
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{fmt(r.people)}</td>
                {shownRes.map((k) => (
                  <td key={k} className="px-2 py-1 text-right tabular-nums">
                    {r.res[k] >= 1 ? fmt(r.res[k]) : <span className="text-slate-700">–</span>}
                  </td>
                ))}
                {unitIds.map((id) => (
                  <td key={id} className="px-2 py-1 text-right tabular-nums">
                    {units[id] ? units[id] : <span className="text-slate-700">–</span>}
                  </td>
                ))}
              </tr>
            );
          })}
          <tr className="border-t-2 border-slate-700 font-medium text-white">
            <td className="px-2 py-1">Total in {rows.length} regions</td>
            <td className="px-2 py-1 text-right tabular-nums">{fmt(totals.people)}</td>
            {shownRes.map((k) => (
              <td key={k} className="px-2 py-1 text-right tabular-nums">
                {fmt(totals.res[k])}
              </td>
            ))}
            {unitIds.map((id) => (
              <td key={id} className="px-2 py-1 text-right tabular-nums">
                {totals.units[id] ?? 0}
              </td>
            ))}
          </tr>
          {state.armies.length > 0 && (
            <tr className="border-t border-slate-900 text-slate-400">
              <td className="px-2 py-1">On the move ({state.armies.length} groups)</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmt(state.armies.reduce((a, x) => a + (x.cargo.people ?? 0), 0))}</td>
              {shownRes.map((k) => (
                <td key={k} className="px-2 py-1 text-right tabular-nums">
                  {(moving.cargo[k] ?? 0) >= 1 ? fmt(moving.cargo[k]!) : <span className="text-slate-700">–</span>}
                </td>
              ))}
              {unitIds.map((id) => (
                <td key={id} className="px-2 py-1 text-right tabular-nums">
                  {moving.units[id] ? moving.units[id] : <span className="text-slate-700">–</span>}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
      {state.armies.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Moving: {state.armies.map((a) => `${missionLabel(a.mission)} → ${regionById(a.status === "returning" ? a.originRegionId : a.targetRegionId)?.name}`).join(" · ")}
        </p>
      )}
    </div>
  );
}
