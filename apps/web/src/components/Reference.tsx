import { useState } from "react";
import { AGES, BUILDINGS, BUILDING_CATEGORIES, TECHS, UNITS, buildingById, buildingSeconds, formatCountdown, techById, techSeconds, trainSeconds, type AgeIndex, type BuildingDef, type Cost, type TechDef, type UnitDef } from "@lastthaw/shared";
import { Card } from "./ui.js";

/** The whole content table of the game, by age: every tech with what it needs and gives, every building, every unit with its numbers. Read from the same data the game runs on. */

const RES: Array<{ key: keyof Cost; label: string }> = [
  { key: "food", label: "food" },
  { key: "wood", label: "wood" },
  { key: "stone", label: "stone" },
  { key: "copper", label: "copper" },
  { key: "tin", label: "tin" },
  { key: "iron", label: "iron" },
  { key: "horses", label: "horses" },
];

function costText(cost: Cost): string {
  const parts = RES.filter((r) => (cost[r.key] ?? 0) > 0).map((r) => `${cost[r.key]} ${r.label}`);
  return parts.length ? parts.join(", ") : "free";
}

const pct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;

function buildingEffects(b: BuildingDef): string[] {
  const e = b.effect;
  const out: string[] = [];
  if (e.capacity) out.push(`+${e.capacity} people per level`);
  if (e.storage) out.push(`${pct(e.storage)} storage per level`);
  if (e.foodStorage) out.push(`${pct(e.foodStorage)} food storage per level`);
  if (e.yield) for (const [k, v] of Object.entries(e.yield)) if (v) out.push(`${pct(v)} ${k} per level`);
  if (e.extract) for (const [k, v] of Object.entries(e.extract)) if (v) out.push(`${v} ${k} an hour per level`);
  if (e.defense) out.push(`${pct(e.defense)} defence`);
  if (e.loyalty) out.push(`+${Math.round(e.loyalty * 100)} loyalty per level`);
  if (e.researchSpeed) out.push(`${pct(e.researchSpeed)} research speed per level`);
  if (e.trainSpeed) out.push(`${pct(e.trainSpeed)} training speed per level`);
  if (e.protect) out.push(`${e.protect} of each resource hidden from raids per level`);
  if (e.harbor) out.push("opens the sea lanes");
  if (b.perNeighbor) out.push("cost is per neighbouring region");
  if (b.capitalOnly) out.push("capital only");
  if (b.wonder) out.push("finishing it wins the match");
  if (b.needsCoast) out.push("needs a coast");
  if (b.needsResource?.length) out.push(`needs ${b.needsResource.join(" or ")} in the region`);
  return out;
}

function techEffects(t: TechDef): string[] {
  const out: string[] = [];
  if (t.advancesTo !== undefined) out.push(`advances to the ${AGES[t.advancesTo]} Age`);
  const e = t.effect ?? {};
  if (e.yield) for (const [k, v] of Object.entries(e.yield)) if (v) out.push(`${pct(v)} ${k}`);
  if (e.capacity) out.push(`+${e.capacity} people per region`);
  if (e.storage) out.push(`${pct(e.storage)} storage`);
  if (e.growth) out.push(`${pct(e.growth)} growth`);
  if (e.extract) out.push(`${pct(e.extract)} ore and horses`);
  if (e.attack) out.push(`${pct(e.attack)} attack`);
  if (e.defense) out.push(`${pct(e.defense)} defence`);
  if (e.trainSpeed) out.push(`${pct(e.trainSpeed)} training speed`);
  if (e.researchSpeed) out.push(`${pct(e.researchSpeed)} research speed`);
  if (e.travel) out.push(`${pct(-e.travel)} travel time`);
  if (e.loyalty) out.push(`+${Math.round(e.loyalty * 100)} loyalty`);
  if (e.vision) out.push(`+${e.vision} sight`);
  if (e.plagueResist) out.push(e.plagueResist >= 1 ? "no plague" : `${pct(-e.plagueResist)} plague risk`);
  const unlocksB = BUILDINGS.filter((b) => b.requires === t.id).map((b) => b.name);
  const unlocksU = UNITS.filter((u) => u.requires === t.id && !u.hidden).map((u) => u.name);
  if (unlocksB.length) out.push(`unlocks ${unlocksB.join(", ")}`);
  if (unlocksU.length) out.push(`unlocks ${unlocksU.join(", ")}`);
  return out;
}

const name = (id: string) => techById.get(id)?.name ?? buildingById.get(id)?.name ?? id;

/** Durations at 1x; faster matches scale them down. */
const dur = (s: number) => formatCountdown(s);

export function Reference() {
  const [age, setAge] = useState<AgeIndex>(0);
  const [kind, setKind] = useState<"techs" | "buildings" | "units">("techs");
  const techs = TECHS.filter((t) => t.age === age);
  const buildings = BUILDINGS.filter((b) => b.age === age);
  const units = UNITS.filter((u) => u.age === age && !u.hidden);
  const th = "px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500";
  const td = "px-2 py-1.5 align-top";
  return (
    <section className="space-y-3" id="reference">
      <h2 className="display text-xl font-semibold text-white">The ages: techs, buildings and units</h2>
      <p className="text-sm text-slate-300">
        Everything in the game, by age, straight from the tables the game runs on. Costs are the base cost; buildings cost more each level and most prices climb with the match day. Times are at 1x, the tournament pace, and shrink at faster speeds.
      </p>
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
        <span className="px-2 text-xs uppercase tracking-wide text-slate-500">Age</span>
        {AGES.map((a, i) => (
          <button key={a} onClick={() => setAge(i as AgeIndex)} className={`rounded px-3 py-1 text-sm ${age === i ? "bg-sky-500/20 text-sky-200" : "text-slate-400 hover:text-slate-200"}`}>
            {a}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
        <span className="px-2 text-xs uppercase tracking-wide text-slate-500">Show</span>
        {(
          [
            ["techs", `Techs (${techs.length})`],
            ["buildings", `Buildings (${buildings.length})`],
            ["units", `Units (${units.length})`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} onClick={() => setKind(k)} className={`rounded px-3 py-1 text-sm ${kind === k ? "bg-amber-400/20 text-amber-200" : "text-slate-400 hover:text-slate-200"}`}>
            {label}
          </button>
        ))}
      </div>

      {kind === "techs" && (
      <Card className="overflow-x-auto p-0">
        <h3 className="display px-3 pt-3 font-semibold text-white">{AGES[age]} Age techs</h3>
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr>
              <th className={th}>Tech</th>
              <th className={th}>Needs</th>
              <th className={th}>Cost</th>
              <th className={th}>Time</th>
              <th className={th}>Gives</th>
            </tr>
          </thead>
          <tbody>
            {techs.map((t) => (
              <tr key={t.id} className="border-t border-slate-800">
                <td className={td}>
                  <span className="font-medium text-slate-100">{t.name}</span>
                  <p className="text-xs text-slate-400">{t.description}</p>
                </td>
                <td className={`${td} text-slate-300`}>
                  {(t.requires ?? []).map(name).join(", ") || "nothing"}
                  {t.earliestDay ? <span className="block text-xs text-slate-500">from day {t.earliestDay + 1}</span> : null}
                </td>
                <td className={`${td} text-slate-300`}>{costText(t.cost)}</td>
                <td className={`${td} tabular-nums text-slate-300`}>{dur(techSeconds(t))}</td>
                <td className={`${td} text-slate-300`}>{techEffects(t).join("; ") || "opens the way"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      )}

      {kind === "buildings" && (
      <Card className="overflow-x-auto p-0">
        <h3 className="display px-3 pt-3 font-semibold text-white">{AGES[age]} Age buildings</h3>
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr>
              <th className={th}>Building</th>
              <th className={th}>Kind</th>
              <th className={th}>Needs</th>
              <th className={th}>Cost (level 1)</th>
              <th className={th}>Time (level 1)</th>
              <th className={th}>Levels</th>
              <th className={th}>Does</th>
            </tr>
          </thead>
          <tbody>
            {buildings.map((b) => (
              <tr key={b.id} className="border-t border-slate-800">
                <td className={td}>
                  <span className="font-medium text-slate-100">{b.name}</span>
                  <p className="text-xs text-slate-400">{b.description}</p>
                </td>
                <td className={`${td} text-slate-300`}>{BUILDING_CATEGORIES.find((c) => c.id === b.category)?.name ?? b.category}</td>
                <td className={`${td} text-slate-300`}>{[b.requires && name(b.requires), b.requiresBuilding && name(b.requiresBuilding)].filter(Boolean).join(", ") || "nothing"}</td>
                <td className={`${td} text-slate-300`}>{costText(b.cost)}</td>
                <td className={`${td} tabular-nums text-slate-300`}>{dur(buildingSeconds(b, 1))}</td>
                <td className={`${td} tabular-nums text-slate-300`}>{b.maxLevel}</td>
                <td className={`${td} text-slate-300`}>{buildingEffects(b).join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      )}

      {kind === "units" && (
      <Card className="overflow-x-auto p-0">
        <h3 className="display px-3 pt-3 font-semibold text-white">{AGES[age]} Age units</h3>
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr>
              <th className={th}>Unit</th>
              <th className={th}>Needs</th>
              <th className={th}>Attack</th>
              <th className={th}>Defence</th>
              <th className={th}>Speed</th>
              <th className={th}>Carry</th>
              <th className={th}>Siege</th>
              <th className={th}>Cost (each)</th>
              <th className={th}>Time (one)</th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.id} className="border-t border-slate-800">
                <td className={td}>
                  <span className="font-medium text-slate-100">{u.name}</span>
                  <p className="text-xs text-slate-400">
                    {u.description}
                    {u.civilian ? " Civilian: never fights." : ""}
                    {u.hauler ? " Hauler: carries goods on trade routes." : ""}
                    {u.naval ? " Ship: sails the sea lanes." : ""}
                    {u.minBatch ? ` Trained ${u.minBatch} at a time.` : ""}
                  </p>
                </td>
                <td className={`${td} text-slate-300`}>{[u.requires && name(u.requires), u.needsBuilding && name(u.needsBuilding), u.needsResource && `${u.needsResource} in the region`].filter(Boolean).join(", ") || "nothing"}</td>
                <td className={`${td} tabular-nums text-slate-300`}>{u.attack}</td>
                <td className={`${td} tabular-nums text-slate-300`}>{u.defense}</td>
                <td className={`${td} tabular-nums text-slate-300`}>{u.speed > 0 ? `${u.speed} km/h` : "stays home"}</td>
                <td className={`${td} tabular-nums text-slate-300`}>{u.carry}</td>
                <td className={`${td} tabular-nums text-slate-300`}>{u.breach ?? "–"}</td>
                <td className={`${td} text-slate-300`}>{costText(u.cost)}</td>
                <td className={`${td} tabular-nums text-slate-300`}>{u.baseSeconds > 0 ? dur(trainSeconds(u, 1)) : "–"}</td>
              </tr>
            ))}
            {units.length === 0 && (
              <tr>
                <td className={`${td} text-slate-500`} colSpan={9}>
                  No new units this age.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      )}
      <p className="text-xs text-slate-500">Ages: {AGES.join(" → ")}. Each age's advancing tech is in its tech table; research it and the next age's tables open.</p>
    </section>
  );
}
