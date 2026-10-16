import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { AGES, BUILDINGS, TECHS, UNITS, buildingSeconds, formatCountdown, techSeconds, trainSeconds, type Cost } from "@lastthaw/shared";

/**
 * The whole tree as one picture: one band per age, techs in green, buildings
 * in orange, units in blue, and a line from each thing to what it opens.
 * Click a node to light up everything it needs and everything it leads to;
 * drag to pan, wheel or buttons to zoom.
 */

type Kind = "tech" | "building" | "unit";
interface Node {
  id: string;
  kind: Kind;
  name: string;
  age: number;
  parents: string[];
  tip: string;
  x: number;
  y: number;
}

const W = 108;
const H = 44;
const GAP_X = 14;
const ROW_H = 150;
const LEFT = 120;
const TOP = 16;
const COLORS: Record<Kind, { fill: string; stroke: string; icon: string }> = {
  tech: { fill: "#1f5f3a", stroke: "#4ade80", icon: "📜" },
  building: { fill: "#7a3e14", stroke: "#fb923c", icon: "🏠" },
  unit: { fill: "#1d4e7a", stroke: "#60a5fa", icon: "⚔" },
};

const cost = (c: Cost) =>
  Object.entries(c)
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ") || "free";

function buildNodes(): { nodes: Node[]; byId: Map<string, Node> } {
  const nodes: Node[] = [];
  for (const t of TECHS) nodes.push({ id: t.id, kind: "tech", name: t.name, age: t.age, parents: [...(t.requires ?? [])], tip: `${t.name} (tech, ${AGES[t.age]} Age)\n${t.description}\nCost: ${cost(t.cost)} · Time: ${formatCountdown(techSeconds(t))}${t.advancesTo !== undefined ? `\nAdvances to the ${AGES[t.advancesTo]} Age` : ""}`, x: 0, y: 0 });
  for (const b of BUILDINGS) nodes.push({ id: b.id, kind: "building", name: b.name, age: b.age, parents: [b.requires, b.requiresBuilding].filter((x): x is string => !!x), tip: `${b.name} (building, ${AGES[b.age]} Age)\n${b.description}\nCost: ${cost(b.cost)} · Time: ${formatCountdown(buildingSeconds(b, 1))} · up to level ${b.maxLevel}`, x: 0, y: 0 });
  for (const u of UNITS) if (!u.hidden) nodes.push({ id: u.id, kind: "unit", name: u.name, age: u.age, parents: [u.requires, u.needsBuilding].filter((x): x is string => !!x), tip: `${u.name} (unit, ${AGES[u.age]} Age)\n${u.description}\nAttack ${u.attack} · Defence ${u.defense}${u.breach ? ` · Siege ${u.breach}` : ""} · Speed ${u.speed} · Carry ${u.carry}\nCost: ${cost(u.cost)} each · Time: ${u.baseSeconds > 0 ? formatCountdown(trainSeconds(u, 1)) : "not trained"}`, x: 0, y: 0 });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Layout: a row per age; within a row, children sit under the average of their parents, roots go first by kind.
  const kindOrder: Record<Kind, number> = { building: 0, unit: 1, tech: 2 };
  for (let age = 0; age < AGES.length; age++) {
    const row = nodes.filter((n) => n.age === age);
    const bary = (n: Node) => {
      const ps = n.parents.map((p) => byId.get(p)).filter((p): p is Node => !!p && p.age < age);
      return ps.length ? ps.reduce((a, p) => a + p.x, 0) / ps.length : Number.POSITIVE_INFINITY;
    };
    row.sort((a, b) => {
      const ba = bary(a);
      const bb = bary(b);
      if (ba !== bb) return ba - bb;
      return kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name);
    });
    row.forEach((n, i) => {
      n.x = LEFT + i * (W + GAP_X);
      n.y = TOP + age * ROW_H + 50;
    });
  }
  return { nodes, byId };
}

function wrap(name: string): [string, string | undefined] {
  if (name.length <= 13) return [name, undefined];
  const words = name.split(" ");
  let first = "";
  while (words.length && (first + " " + words[0]).trim().length <= 13) first = (first + " " + words.shift()).trim();
  if (!first) first = words.shift()!;
  return [first, words.join(" ") || undefined];
}

export interface TreeProgress {
  /** Techs researched. */
  done: ReadonlySet<string>;
  /** Techs queued for research. */
  queued: ReadonlySet<string>;
  /** The player's age; buildings and units of later ages are locked whatever the techs. */
  age: number;
}

export function TechTreeGraph({ progress, height: boxHeight = "70vh" }: { progress?: TreeProgress; height?: string }) {
  const { nodes, byId } = useMemo(buildNodes, []);
  // In a match: what is done, what is on the way, what could be done now, and what is still locked.
  const status = (n: Node): "done" | "queued" | "available" | "locked" | "plain" => {
    if (!progress) return "plain";
    const techsOk = n.parents.filter((p) => byId.get(p)?.kind === "tech").every((p) => progress.done.has(p));
    if (n.kind === "tech") return progress.done.has(n.id) ? "done" : progress.queued.has(n.id) ? "queued" : techsOk && n.age <= progress.age ? "available" : "locked";
    return techsOk && n.age <= progress.age ? "done" : "locked";
  };
  const width = Math.max(...nodes.map((n) => n.x)) + W + 24;
  const height = TOP + AGES.length * ROW_H;
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ scale: 0.7, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const related = useMemo(() => {
    if (!selected) return null;
    const set = new Set<string>([selected]);
    const up = (id: string) => {
      for (const p of byId.get(id)?.parents ?? []) if (!set.has(p)) { set.add(p); up(p); }
    };
    const down = (id: string) => {
      for (const n of nodes) if (n.parents.includes(id) && !set.has(n.id)) { set.add(n.id); down(n.id); }
    };
    up(selected);
    down(selected);
    return set;
  }, [selected, nodes, byId]);

  const fit = () => {
    const w = box.current?.clientWidth ?? 1000;
    setView({ scale: Math.min(1, w / width), x: 0, y: 0 });
  };
  const zoom = (f: number) => setView((v) => ({ ...v, scale: Math.min(2, Math.max(0.25, v.scale * f)) }));
  const onPointerDown = (e: ReactPointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // Read the drag origin now: the state update runs later, by which time the pointer may have been released.
    const x = d.vx + (e.clientX - d.x);
    const y = d.vy + (e.clientY - d.y);
    setView((v) => ({ ...v, x, y }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e: ReactWheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.1 : 0.9);
  };

  const dim = (id: string, st: ReturnType<typeof status>) => (related && !related.has(id) ? 0.18 : st === "locked" ? 0.4 : 1);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: COLORS.tech.fill, border: `1px solid ${COLORS.tech.stroke}` }} /> tech</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: COLORS.building.fill, border: `1px solid ${COLORS.building.stroke}` }} /> building</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: COLORS.unit.fill, border: `1px solid ${COLORS.unit.stroke}` }} /> unit</span>
        <span className="ml-auto inline-flex gap-1">
          <button className="rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800" onClick={() => zoom(1.25)}>+</button>
          <button className="rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800" onClick={() => zoom(0.8)}>−</button>
          <button className="rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800" onClick={fit}>fit</button>
          {selected && (
            <button className="rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800" onClick={() => setSelected(null)}>
              clear
            </button>
          )}
        </span>
      </div>
      <p className="text-xs text-slate-500">
        A line runs from each thing to what it opens. Click a node to light up its whole line; hover for its numbers; drag to move, Ctrl and the wheel or the buttons to zoom.
        {progress ? " Researched techs carry a tick, what you can research now has a white edge, queued ones a dashed edge, and what is still locked is faded." : ""}
      </p>
      <div ref={box} style={{ height: boxHeight }} className="relative cursor-grab touch-none select-none overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70 active:cursor-grabbing" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} onWheel={onWheel}>
        <svg width={width * view.scale} height={height * view.scale} viewBox={`0 0 ${width} ${height}`} style={{ transform: `translate(${view.x}px, ${view.y}px)` }}>
          {AGES.map((a, i) => (
            <g key={a}>
              <rect x={0} y={TOP + i * ROW_H} width={width} height={ROW_H} fill={i % 2 ? "rgba(148,163,184,0.05)" : "rgba(148,163,184,0.02)"} />
              <text x={14} y={TOP + i * ROW_H + 28} fill="#7dd3fc" fontSize={13} fontWeight={700} style={{ letterSpacing: "0.15em" }}>
                {a.toUpperCase()}
              </text>
              <text x={14} y={TOP + i * ROW_H + 44} fill="#64748b" fontSize={11}>
                age {i + 1}
              </text>
            </g>
          ))}
          {nodes.flatMap((n) =>
            n.parents.map((pid) => {
              const p = byId.get(pid);
              if (!p) return null;
              const x1 = p.x + W / 2;
              const y1 = p.y + H;
              const x2 = n.x + W / 2;
              const y2 = n.y;
              const midY = p.age === n.age ? y1 + 10 : y2 - 24;
              const on = related ? related.has(n.id) && related.has(pid) : false;
              return <path key={`${pid}-${n.id}`} d={`M${x1},${y1} V${midY} H${x2} V${y2}`} fill="none" stroke={on ? "#fbbf24" : "#64748b"} strokeWidth={on ? 2 : 1} opacity={related ? (on ? 1 : 0.12) : 0.55} />;
            }),
          )}
          {nodes.map((n) => {
            const [l1, l2] = wrap(n.name);
            const c = COLORS[n.kind];
            const sel = selected === n.id;
            const st = status(n);
            const stroke = sel ? "#fbbf24" : st === "queued" ? "#fbbf24" : st === "available" ? "#f8fafc" : c.stroke;
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={dim(n.id, st)} style={{ cursor: "pointer" }} onClick={() => setSelected(sel ? null : n.id)}>
                <title>{n.tip}{progress ? `
${st === "done" ? (n.kind === "tech" ? "Researched" : "Available to you") : st === "queued" ? "Queued for research" : st === "available" ? "Can be researched now" : "Locked"}` : ""}</title>
                <rect width={W} height={H} rx={5} fill={c.fill} stroke={stroke} strokeWidth={sel || st === "available" || st === "queued" ? 2.5 : 1} strokeDasharray={st === "queued" ? "4 3" : undefined} />
                {progress && st === "done" && n.kind === "tech" && (
                  <text x={W - 14} y={14} fontSize={11} fill="#86efac">
                    ✓
                  </text>
                )}
                <text x={8} y={l2 ? 19 : 27} fontSize={12} fill="#ffffff">
                  {c.icon}
                </text>
                <text x={28} y={l2 ? 18 : 27} fontSize={11} fontWeight={600} fill="#f8fafc">
                  {l1}
                </text>
                {l2 && (
                  <text x={28} y={33} fontSize={11} fontWeight={600} fill="#f8fafc">
                    {l2}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
