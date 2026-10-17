import { techUnlocks } from "./previews.js";
import { useState } from "react";
import { AGES, BUILDINGS, BUILDING_CATEGORIES, TECHS, UNITS, buildingById, buildingSeconds, formatCountdown, techById, techSeconds, trainSeconds, type AgeIndex, type BuildingDef, type Cost, type TechDef, type UnitDef } from "@lastthaw/shared";

/**
 * The content tables of the game as cards, by age: every tech with what it
 * needs and gives, every building, every unit with its numbers. Read from the
 * same data the game runs on, laid out to fit the screen without scrolling
 * sideways.
 */

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
const name = (id: string) => techById.get(id)?.name ?? buildingById.get(id)?.name ?? id;

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
  if (e.protect) out.push(`hides ${e.protect} of each resource from raids per level`);
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
  const kids = techUnlocks(t.id);
  if (kids.buildings.length) out.push(`unlocks ${kids.buildings.join(", ")}`);
  if (kids.units.length) out.push(`unlocks ${kids.units.join(", ")}`);
  if (kids.techs.length) out.push(`leads to ${kids.techs.join(", ")}`);
  return out;
}

function AgeTabs({ age, setAge }: { age: AgeIndex; setAge: (a: AgeIndex) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
      <span className="px-2 text-xs uppercase tracking-wide text-slate-500">Age</span>
      {AGES.map((a, i) => (
        <button key={a} onClick={() => setAge(i as AgeIndex)} className={`rounded px-3 py-1 text-sm ${age === i ? "bg-sky-500/20 text-sky-200" : "text-slate-400 hover:text-slate-200"}`}>
          {a}
        </button>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-14 shrink-0 text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <span className="text-slate-300">{value}</span>
    </div>
  );
}

function Entry({ title, description, rows, badge }: { title: string; description: string; rows: Array<[string, string]>; badge?: string | undefined }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-slate-100">{title}</h3>
        {badge && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">{badge}</span>}
      </div>
      <p className="mb-2 text-xs text-slate-400">{description}</p>
      <div className="space-y-0.5">
        {rows.map(([l, v]) => (
          <Row key={l} label={l} value={v} />
        ))}
      </div>
    </div>
  );
}

const note = "Costs are the base cost; most prices climb with the match day. Times are at 1x, the tournament pace, and shrink at faster speeds.";

export function TechTree() {
  const [age, setAge] = useState<AgeIndex>(0);
  const techs = TECHS.filter((t) => t.age === age);
  return (
    <section className="space-y-3">
      <p className="text-sm text-slate-300">Research runs from a queue of its own and draws ore and horses from any region you own. Each age's last tech opens the next age. {note}</p>
      <AgeTabs age={age} setAge={setAge} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {techs.map((t) => (
          <Entry
            key={t.id}
            title={t.name}
            description={t.description}
            badge={t.advancesTo !== undefined ? `to ${AGES[t.advancesTo]}` : undefined}
            rows={[
              ["gives", techEffects(t).join("; ") || "opens the way"],
              ["needs", (t.requires ?? []).map(name).join(", ") + (t.earliestDay ? ` (from day ${t.earliestDay + 1})` : "") || "nothing"],
              ["cost", costText(t.cost)],
              ["time", formatCountdown(techSeconds(t))],
            ]}
          />
        ))}
      </div>
    </section>
  );
}

export function BuildingList() {
  const [age, setAge] = useState<AgeIndex>(0);
  const buildings = BUILDINGS.filter((b) => b.age === age);
  return (
    <section className="space-y-3">
      <p className="text-sm text-slate-300">Each region has a build queue with ten slots. Buildings cost more and take longer each level. {note}</p>
      <AgeTabs age={age} setAge={setAge} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {buildings.map((b) => (
          <Entry
            key={b.id}
            title={b.name}
            description={b.description}
            badge={BUILDING_CATEGORIES.find((c) => c.id === b.category)?.name ?? b.category}
            rows={[
              ["needs", [b.requires && name(b.requires), b.requiresBuilding && name(b.requiresBuilding)].filter(Boolean).join(", ") || "nothing"],
              ["cost", `${costText(b.cost)} (level 1)`],
              ["time", `${formatCountdown(buildingSeconds(b, 1))} (level 1)`],
              ["levels", String(b.maxLevel)],
              ["does", buildingEffects(b).join("; ")],
            ]}
          />
        ))}
      </div>
    </section>
  );
}

export function UnitList() {
  const [age, setAge] = useState<AgeIndex>(0);
  const units = UNITS.filter((u) => u.age === age && !u.hidden);
  const kind = (u: UnitDef) => (u.civilian ? "civilian" : u.hauler ? "hauler" : u.naval ? "ship" : (u.breach ?? 0) > 0 ? "siege" : "soldier");
  return (
    <section className="space-y-3">
      <p className="text-sm text-slate-300">Soldiers are trained from workers and eat three times as much. An army moves at the pace of its slowest unit. Siege value is how much wall a unit knocks down. {note}</p>
      <AgeTabs age={age} setAge={setAge} />
      {units.length === 0 && <p className="text-sm text-slate-500">No new units this age.</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {units.map((u) => (
          <Entry
            key={u.id}
            title={u.name}
            description={`${u.description}${u.minBatch ? ` Trained ${u.minBatch} at a time.` : ""}`}
            badge={kind(u)}
            rows={[
              ["needs", [u.requires && name(u.requires), u.needsBuilding && name(u.needsBuilding), u.needsResource && `${u.needsResource} in the region`].filter(Boolean).join(", ") || "nothing"],
              ["fight", `attack ${u.attack}, defence ${u.defense}${u.breach ? `, siege ${u.breach}` : ""}`],
              ["move", u.speed > 0 ? `${u.speed} km/h, carries ${u.carry}` : "stays home"],
              ["cost", `${costText(u.cost)} each`],
              ["time", u.baseSeconds > 0 ? `${formatCountdown(trainSeconds(u, 1))} for one` : "not trained"],
            ]}
          />
        ))}
      </div>
    </section>
  );
}
