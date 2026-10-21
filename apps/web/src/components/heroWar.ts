import { AGES, TECHS, allRegions, balance, iceLatitudeOnDay } from "@lastthaw/shared";

/**
 * The home page's match in a minute: eight tribes on the real map claim the land around their capitals, conquer
 * their neighbours, sail fleets to far coasts, then shell and bomb each other in the modern ages while the ice
 * closes in from both poles on the real schedule. A scripted, seeded show; nothing here talks to a server.
 */

export const HERO_DAYS = balance.match.lengthDays;
/** Seconds the thirty days take, then seconds held on the winner. */
const LOOP = 55;
const HOLD = 6;
const VB = { x: 0, y: 85, w: 2000, h: 820 };
const COLORS = ["#38bdf8", "#f472b6", "#a3e635", "#fb923c", "#c084fc", "#2dd4bf", "#facc15", "#f87171"];
const TRIBES: Array<{ name: string; at: [number, number] }> = [
  { name: "Red Elk", at: [47, 2] },
  { name: "Grey Fen", at: [34, 108] },
  { name: "Salt Kings", at: [37, -88] },
  { name: "Sun Riders", at: [-12, -50] },
  { name: "Ashen Crows", at: [9, 8] },
  { name: "Tide Callers", at: [22, 78] },
  { name: "Iron Wolves", at: [-26, 135] },
  { name: "Bog Folk", at: [33, 48] },
];

/** The day (counting whole days gone) each age may first be reached, from the techs that advance the age. */
const AGE_FROM: number[] = AGES.map((_, age) => {
  if (age === 0) return 0;
  const t = TECHS.find((x) => x.advancesTo === age);
  return t?.earliestDay ?? age;
});
export const ageOn = (d: number) => AGE_FROM.reduce((a, from, age) => (d >= from ? age : a), 0);
const CONQUER = balance.match.protectionDays;
const SEAS = Math.max(AGE_FROM[3] ?? 4, CONQUER) + 3;
const SKIES = AGE_FROM[6] ?? 14;
const LATE = AGE_FROM[5] ?? 10;
const ICE_PHASE = Math.max(SKIES + 5, 21);

export const PHASES = [
  { from: 0, big: "Claim your land", small: "Five settlers, one region, thirty days." },
  { from: 2, big: "Build an empire", small: "Settle the land around you before your rivals do." },
  { from: CONQUER, big: "Conquer your enemies", small: "Raid for loot. March in and take their regions." },
  { from: SEAS, big: "Cross the seas", small: "Fleets carry armies to far coasts." },
  { from: SKIES, big: "Take to the skies", small: "Bombers, artillery and rifles in the modern age." },
  { from: ICE_PHASE, big: "Outrun the ice", small: "Everything beyond the line freezes. Move south or lose it all." },
];

interface Region { name: string; x: number; y: number; lat: number; lon: number; coastal: boolean; value: number; nb: number[]; sr: number[]; path: Path2D }
interface Tribe { name: string; color: string; cap: number; alive: boolean; aggr: number; count: number }
interface Battle { t0: number; dur: number; def: number; win: boolean }
interface Op { kind: "settle" | "army" | "ship" | "plane"; t: number; from: number; to: number; t0: number; dur: number; bombs: number; battle?: Battle; done?: boolean }
type Fx =
  | { kind: "shell"; x0: number; y0: number; x1: number; y1: number; life: number; max: number; late: boolean }
  | { kind: "boom"; x: number; y: number; s: number; life: number; max: number }
  | { kind: "tracer" | "clash"; x: number; y: number; a: number; life: number; max: number };

export interface HeroEvents {
  caption: (big: string, small: string) => void;
  news: (text: string, color: string) => void;
}

function seeded(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mix(a: string, b: string, t: number) {
  const h = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const x = h(a), y = h(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i]! - v) * t)).join(",")})`;
}

export class HeroWar {
  private ctx: CanvasRenderingContext2D;
  private R: Region[];
  private n: number;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private rng = seeded(1);
  private owner = new Int8Array(0);
  private frozen = new Uint8Array(0);
  private gain = new Float32Array(0);
  private flashT = new Float32Array(0);
  private tribes: Tribe[] = [];
  private ops: Op[] = [];
  private fx: Fx[] = [];
  private wakes: Array<{ x: number; y: number; t: number }> = [];
  private busy = new Set<number>();
  private snow = Array.from({ length: 60 }, () => ({ x: Math.random() * 1200, y: Math.random() * 500, r: 0.5 + Math.random(), v: 10 + Math.random() * 18, p: Math.random() * 6 }));
  private lastAct = 0;
  private lastIce = 0;
  private phase = -1;
  private winner = -1;
  private lastNews = 0;
  /** On a narrow, tall screen only part of the world fits: the camera pans to the latest big moment. */
  private camX = 1000;
  private focusX = 1000;
  private focusAt = -99;
  gt = 0;

  constructor(private canvas: HTMLCanvasElement, private on: HeroEvents, private reduce: boolean) {
    this.ctx = canvas.getContext("2d")!;
    const regions = allRegions();
    const idx = new Map(regions.map((r, i) => [r.id, i]));
    this.R = regions.map((r) => ({
      name: r.name, x: r.x, y: r.y, lat: r.lat, lon: r.lon, coastal: r.coastal, value: r.value,
      nb: r.neighbors.map((id) => idx.get(id)).filter((i): i is number => i !== undefined),
      sr: r.seaRoutes.map((id) => idx.get(id)).filter((i): i is number => i !== undefined),
      path: new Path2D(r.path),
    }));
    this.n = this.R.length;
    this.resize();
    this.reset();
  }

  get day() {
    return Math.min(HERO_DAYS, (this.gt / LOOP) * HERO_DAYS);
  }
  get progress() {
    return Math.min(1, this.gt / LOOP);
  }
  iceLat() {
    return iceLatitudeOnDay(this.day);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(280, r.width);
    this.H = r.height > 10 ? r.height : (this.W * VB.h) / VB.w;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
  }

  reset() {
    this.rng = seeded(Math.floor(Math.random() * 1e9));
    this.owner = new Int8Array(this.n).fill(-1);
    this.frozen = new Uint8Array(this.n);
    this.gain = new Float32Array(this.n).fill(-9);
    this.flashT = new Float32Array(this.n).fill(-9);
    this.tribes = TRIBES.map((t, i) => ({ name: t.name, color: COLORS[i]!, cap: this.nearest(t.at[0], t.at[1]), alive: true, aggr: 0.6 + this.rng() * 0.8, count: 0 }));
    this.ops = [];
    this.fx = [];
    this.wakes = [];
    this.busy.clear();
    this.gt = 0;
    this.camX = this.focusX = 1000;
    this.focusAt = -99;
    this.lastAct = 0;
    this.lastIce = 0;
    this.phase = -1;
    this.winner = -1;
    this.tribes.forEach((t, i) => this.setOwner(t.cap, i));
  }

  /** Jump ahead without drawing (a still frame for reduced motion). */
  fastForward(seconds: number) {
    for (let i = 0; i < seconds * 20; i++) this.step(0.05);
  }

  private nearest(lat: number, lon: number) {
    let best = 0, bd = Infinity;
    this.R.forEach((r, i) => {
      const d = (r.lat - lat) ** 2 + (r.lon - lon) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }
  private pick<T>(a: readonly T[]): T {
    return a[Math.floor(this.rng() * a.length)]!;
  }
  private dist(a: number, b: number) {
    return Math.hypot(this.R[a]!.x - this.R[b]!.x, this.R[a]!.y - this.R[b]!.y);
  }

  private setOwner(r: number, t: number) {
    const prev = this.owner[r]!;
    if (prev >= 0) this.tribes[prev]!.count--;
    this.owner[r] = t;
    this.gain[r] = this.gt;
    if (t >= 0) this.tribes[t]!.count++;
    const p = prev >= 0 ? this.tribes[prev]! : null;
    if (p && p.cap === r) {
      const rest: number[] = [];
      this.owner.forEach((o, i) => o === prev && !this.frozen[i] && rest.push(i));
      if (rest.length) p.cap = rest.sort((a, b) => Math.abs(this.R[a]!.lat) - Math.abs(this.R[b]!.lat))[0]!;
      else if (p.alive) {
        p.alive = false;
        this.news(`${p.name} ${t >= 0 ? `fell to ${this.tribes[t]!.name}` : "were lost to the ice"}`, t >= 0 ? t : prev, true);
      }
    }
  }

  private news(text: string, t: number, big = false, x?: number) {
    // The camera moves on at most every few seconds, so a phone viewer can follow it.
    if (x !== undefined && this.gt - this.focusAt > 3.5) {
      this.focusX = x;
      this.focusAt = this.gt;
    }
    if (!big && this.gt - this.lastNews < 0.9) return;
    this.lastNews = this.gt;
    this.on.news(text, t >= 0 ? this.tribes[t]!.color : "#e8f4fb");
  }

  private owned(t: number) {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) if (this.owner[i] === t && !this.frozen[i]) out.push(i);
    return out;
  }

  private act() {
    const d = this.day;
    const live = this.tribes.map((_, i) => i).filter((i) => this.tribes[i]!.alive);
    if (!live.length || this.ops.length > 46) return;
    const t = this.pick(live), tr = this.tribes[t]!;
    const mine = this.owned(t);
    if (!mine.length) return;
    const roll = this.rng();
    const warW = d < CONQUER ? 0 : d < CONQUER + 4 ? 0.35 : 0.6 * tr.aggr;
    const seaW = d < SEAS - 2 ? 0 : d < SKIES ? 0.14 : 0.22;
    const airW = d < SKIES ? 0 : 0.16;
    const from = this.pick(mine);
    const fr = this.R[from]!;
    if (roll < airW) {
      const targets: number[] = [];
      for (let i = 0; i < this.n; i++) if (this.owner[i]! >= 0 && this.owner[i] !== t && !this.frozen[i] && this.dist(from, i) < 520 && this.dist(from, i) > 80) targets.push(i);
      if (targets.length) this.ops.push({ kind: "plane", t, from, to: this.pick(targets), t0: this.gt, dur: 2.4 + this.rng() * 0.8, bombs: 0 });
      return;
    }
    if (roll < airW + seaW && fr.coastal && fr.sr.length) {
      const to = this.pick(fr.sr);
      if (!this.frozen[to] && this.owner[to] !== t && !this.busy.has(to)) {
        this.busy.add(to);
        this.ops.push({ kind: "ship", t, from, to, t0: this.gt, dur: 2.6 + this.dist(from, to) / 380, bombs: 0 });
      }
      return;
    }
    const nbs = fr.nb.filter((x) => !this.frozen[x] && !this.busy.has(x));
    const enemy = nbs.filter((x) => this.owner[x]! >= 0 && this.owner[x] !== t);
    const empty = nbs.filter((x) => this.owner[x]! < 0);
    if (warW > 0 && enemy.length && (this.rng() < warW || !empty.length)) {
      const to = this.pick(enemy);
      this.busy.add(to);
      this.ops.push({ kind: "army", t, from, to, t0: this.gt, dur: 1.2, bombs: 0 });
    } else if (empty.length) {
      const to = this.pick(empty);
      this.busy.add(to);
      this.ops.push({ kind: "settle", t, from, to, t0: this.gt, dur: 1.0, bombs: 0 });
    }
  }

  step(dt: number) {
    this.gt += dt;
    const gt = this.gt, d = this.day, R = this.R;
    if (gt < LOOP) {
      const rate = d < 3 ? 0.09 : d < 12 ? 0.07 : 0.085;
      while (gt - this.lastAct > rate) {
        this.lastAct += rate;
        this.act();
      }
    }
    if (gt - this.lastIce > 0.15) {
      this.lastIce = gt;
      const lat = iceLatitudeOnDay(d);
      for (let i = 0; i < this.n; i++)
        if (!this.frozen[i] && Math.abs(R[i]!.lat) >= lat) {
          this.frozen[i] = 1;
          const o = this.owner[i]!;
          if (o >= 0) {
            if (R[i]!.value > 0.9 || this.tribes[o]!.cap === i) this.news(`The ice took ${R[i]!.name}`, -1);
            this.setOwner(i, -1);
          }
        }
    }
    for (const op of this.ops) {
      const p = (gt - op.t0) / op.dur;
      const to = R[op.to]!;
      if (op.kind === "plane") {
        if (p > 0.45 && op.bombs < 5 && this.rng() < dt * 9) {
          op.bombs++;
          this.boom(to.x + (this.rng() - 0.5) * 30, to.y + (this.rng() - 0.5) * 20, 1.2);
          this.flashT[op.to] = gt;
          if (op.bombs === 1) this.news(`${this.tribes[op.t]!.name} bombed ${to.name}`, op.t, false, to.x);
        }
        if (p >= 1) op.done = true;
        continue;
      }
      if (op.kind === "ship" && !op.battle && this.rng() < dt * 10) {
        const q = this.shipPos(op, Math.min(1, p));
        this.wakes.push({ x: q.x, y: q.y, t: gt });
      }
      if (p >= 1 && !op.battle) {
        if (this.owner[op.to] === op.t || this.frozen[op.to]) {
          op.done = true;
          this.busy.delete(op.to);
          continue;
        }
        if (op.kind === "settle" || (op.kind === "ship" && this.owner[op.to]! < 0)) {
          this.setOwner(op.to, op.t);
          op.done = true;
          this.busy.delete(op.to);
          if (op.kind === "ship") this.news(`${this.tribes[op.t]!.name} landed in ${to.name}`, op.t, false, to.x);
          continue;
        }
        op.battle = { t0: gt, dur: 2.2 + this.rng() * 1.2, def: this.owner[op.to]!, win: this.rng() < 0.66 };
      }
      const b = op.battle;
      if (b) {
        this.flashT[op.to] = gt;
        const late = d >= LATE;
        if (this.rng() < dt * (late ? 14 : 7)) this.shots(op, late);
        if (d >= AGE_FROM[2]! && this.rng() < dt * 1.6) this.fx.push({ kind: "shell", x0: R[op.from]!.x, y0: R[op.from]!.y, x1: to.x + (this.rng() - 0.5) * 22, y1: to.y + (this.rng() - 0.5) * 16, life: 0.9, max: 0.9, late });
        if ((gt - b.t0) / b.dur >= 1) {
          op.done = true;
          this.busy.delete(op.to);
          if (b.win && this.owner[op.to] === b.def) {
            this.setOwner(op.to, op.t);
            this.news(`${this.tribes[op.t]!.name} took ${to.name} from ${this.tribes[b.def]!.name}`, op.t, false, to.x);
            for (let i = 0; i < 4; i++) this.boom(to.x + (this.rng() - 0.5) * 16, to.y + (this.rng() - 0.5) * 12, 0.8);
          }
        }
      }
    }
    this.ops = this.ops.filter((o) => !o.done);
    for (const f of this.fx) {
      f.life -= dt;
      if (f.kind === "shell" && f.life <= 0) this.boom(f.x1, f.y1, 1);
    }
    this.fx = this.fx.filter((f) => f.life > 0);
    this.wakes = this.wakes.filter((w) => gt - w.t < 2.2);
    const pi = PHASES.reduce((a, ph, i) => (d >= ph.from ? i : a), 0);
    if (gt < LOOP && pi !== this.phase) {
      this.phase = pi;
      this.on.caption(PHASES[pi]!.big, PHASES[pi]!.small);
    }
    if (gt >= LOOP && this.winner < 0) {
      let best = 0;
      this.tribes.forEach((t, i) => t.count > this.tribes[best]!.count && (best = i));
      this.winner = best;
      const w = this.tribes[best]!;
      this.on.caption(`${w.name} survive the Last Thaw`, `${w.count} regions held when the ice stopped on day ${HERO_DAYS}.`);
    }
    if (gt >= LOOP + HOLD) this.reset();
  }

  private shots(op: Op, late: boolean) {
    const a = this.R[op.from]!, b = this.R[op.to]!;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const r = () => this.rng() - 0.5;
    this.fx.push({ kind: late ? "tracer" : "clash", x: b.x - Math.cos(ang) * 10 + r() * 10, y: b.y - Math.sin(ang) * 10 + r() * 10, a: ang + r() * 0.5, life: 0.25, max: 0.25 });
    if (this.rng() < 0.35) this.fx.push({ kind: "tracer", x: b.x + Math.cos(ang) * 6, y: b.y + Math.sin(ang) * 6, a: ang + Math.PI + r() * 0.5, life: 0.25, max: 0.25 });
  }
  private boom(x: number, y: number, s: number) {
    this.fx.push({ kind: "boom", x, y, s, life: 0.9, max: 0.9 });
  }
  private curve(ax: number, ay: number, mx: number, my: number, bx: number, by: number, p: number) {
    const q = 1 - p;
    return { x: q * q * ax + 2 * q * p * mx + p * p * bx, y: q * q * ay + 2 * q * p * my + p * p * by, ang: Math.atan2(2 * q * (my - ay) + 2 * p * (by - my), 2 * q * (mx - ax) + 2 * p * (bx - mx)) };
  }
  /** Planes overfly the target and keep going a little. */
  private planeAt(op: Op, p: number) {
    const a = this.R[op.from]!, b = this.R[op.to]!;
    const ex = b.x + (b.x - a.x) * 0.35, ey = b.y + (b.y - a.y) * 0.35;
    return this.curve(a.x, a.y, (a.x + ex) / 2, (a.y + ey) / 2 - Math.hypot(ex - a.x, ey - a.y) * 0.12, ex, ey, p);
  }
  private shipPos(op: Op, p: number) {
    const a = this.R[op.from]!, b = this.R[op.to]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, bend = 0.18 * (op.t % 2 ? 1 : -1);
    return this.curve(a.x, a.y, (a.x + b.x) / 2 - ((b.y - a.y) / L) * L * bend, (a.y + b.y) / 2 + ((b.x - a.x) / L) * L * bend, b.x, b.y, p);
  }

  draw() {
    const c = this.ctx, W = this.W, H = this.H, gt = this.gt, R = this.R;
    // Wide screens fit the whole width; tall ones fit the height and pan.
    const sc = Math.max(W / VB.w, H / VB.h);
    const half = W / sc / 2;
    if (half * 2 >= VB.w - 1) this.camX = VB.w / 2;
    else {
      const target = Math.max(half, Math.min(VB.w - half, this.focusX));
      this.camX += (target - this.camX) * 0.03;
      this.camX = Math.max(half, Math.min(VB.w - half, this.camX));
    }
    const ox = W / 2 - this.camX * sc;
    const oy = H / 2 - (VB.y + VB.h / 2) * sc;
    const S = (x: number, y: number): [number, number] => [x * sc + ox, y * sc + oy];
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#0b2038");
    g.addColorStop(0.5, "#0a1c31");
    g.addColorStop(1, "#0b2038");
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    c.setTransform(this.dpr * sc, 0, 0, this.dpr * sc, this.dpr * ox, this.dpr * oy);
    const lw = 1 / sc;
    for (let i = 0; i < this.n; i++) {
      const o = this.owner[i]!;
      c.fillStyle = this.frozen[i] ? "#dcebf3" : o >= 0 ? mix("#2c4a36", this.tribes[o]!.color, 0.25 + 0.6 * Math.min(1, (gt - this.gain[i]!) / 0.5)) : "#2c4a36";
      c.fill(R[i]!.path);
    }
    c.lineWidth = lw * 0.7;
    c.strokeStyle = "rgba(8,20,14,.7)";
    for (let i = 0; i < this.n; i++) c.stroke(R[i]!.path);
    for (let i = 0; i < this.n; i++) {
      if (gt - this.flashT[i]! < 0.3) {
        c.fillStyle = `rgba(244,63,94,${0.25 + 0.3 * Math.abs(Math.sin(gt * 9))})`;
        c.fill(R[i]!.path);
        c.strokeStyle = "rgba(251,113,133,.95)";
        c.lineWidth = lw * 1.6;
        c.stroke(R[i]!.path);
      }
      const since = gt - this.gain[i]!;
      if (since >= 0 && since < 0.8 && this.owner[i]! >= 0) {
        c.strokeStyle = this.tribes[this.owner[i]!]!.color;
        c.globalAlpha = 1 - since / 0.8;
        c.lineWidth = lw * 2;
        c.beginPath();
        c.arc(R[i]!.x, R[i]!.y, 4 + since * 22, 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = 1;
      }
    }
    // The ice caps and the line.
    const lat = this.iceLat(), yN = ((90 - lat) / 180) * 1000, yS = ((90 + lat) / 180) * 1000;
    c.fillStyle = "rgba(232,244,251,.14)";
    c.fillRect(-50, -10, 2100, yN - 50);
    c.fillRect(-50, yS + 50, 2100, 1100 - yS);
    let ig = c.createLinearGradient(0, yN - 60, 0, yN);
    ig.addColorStop(0, "rgba(232,244,251,0)");
    ig.addColorStop(1, "rgba(232,244,251,.28)");
    c.fillStyle = ig;
    c.fillRect(-50, yN - 60, 2100, 60);
    ig = c.createLinearGradient(0, yS, 0, yS + 60);
    ig.addColorStop(0, "rgba(232,244,251,.28)");
    ig.addColorStop(1, "rgba(232,244,251,0)");
    c.fillStyle = ig;
    c.fillRect(-50, yS, 2100, 60);
    c.setLineDash([8 * lw, 6 * lw]);
    c.strokeStyle = "rgba(232,244,251,.8)";
    c.lineWidth = lw * 1.2;
    c.beginPath();
    c.moveTo(0, yN);
    c.lineTo(2000, yN);
    c.moveTo(0, yS);
    c.lineTo(2000, yS);
    c.stroke();
    c.setLineDash([]);

    // Screen space: units keep a readable size whatever the width.
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const u = Math.max(0.85, Math.min(2, (sc * VB.w) / 1100));
    for (const w of this.wakes) {
      const [x, y] = S(w.x, w.y);
      const a = 1 - (gt - w.t) / 2.2;
      c.fillStyle = `rgba(200,225,240,${0.35 * a})`;
      dot(c, x, y, (1 + (1 - a) * 3) * u);
    }
    for (const t of this.tribes) if (t.alive && !this.frozen[t.cap]) star(c, ...S(R[t.cap]!.x, R[t.cap]!.y), 5 * u, t.color);
    for (const f of this.fx) {
      const a = f.life / f.max;
      if (f.kind === "shell") {
        const p = 1 - a;
        const [x, y] = S(f.x0 + (f.x1 - f.x0) * p, f.y0 + (f.y1 - f.y0) * p);
        c.fillStyle = f.late ? "#ffd28a" : "#c9b79a";
        dot(c, x, y - Math.sin(p * Math.PI) * 26 * u, 1.6 * u);
      } else if (f.kind === "boom") {
        const [x, y] = S(f.x, f.y);
        const p = 1 - a;
        c.fillStyle = `rgba(255,${Math.round(200 - 120 * p)},90,${a})`;
        dot(c, x, y, (2 + p * 7) * u * f.s);
        c.fillStyle = `rgba(90,90,96,${a * 0.6})`;
        dot(c, x + 2 * u, y - p * 9 * u, (3 + p * 6) * u * f.s);
      } else if (f.kind === "tracer") {
        const [x, y] = S(f.x, f.y);
        const L = (1 - a) * 14 * u;
        c.strokeStyle = `rgba(255,236,170,${a})`;
        c.lineWidth = 1.1 * u;
        line(c, x + Math.cos(f.a) * L, y + Math.sin(f.a) * L, x + Math.cos(f.a) * (L + 5 * u), y + Math.sin(f.a) * (L + 5 * u));
        c.fillStyle = `rgba(255,220,120,${a})`;
        dot(c, x, y, 1.3 * u * a);
      } else {
        const [x, y] = S(f.x, f.y);
        c.strokeStyle = `rgba(255,246,213,${a})`;
        c.lineWidth = u;
        for (let k = 0; k < 4; k++) {
          const an = f.a + k * 1.57;
          line(c, x + Math.cos(an) * 2 * u, y + Math.sin(an) * 2 * u, x + Math.cos(an) * 5 * u, y + Math.sin(an) * 5 * u);
        }
      }
    }
    const late = this.day >= LATE;
    for (const op of this.ops) {
      const p = Math.min(1, (gt - op.t0) / op.dur);
      const tc = this.tribes[op.t]!.color;
      const a = R[op.from]!, b = R[op.to]!;
      if (op.kind === "settle" || op.kind === "army") {
        const q = Math.min(p, op.kind === "army" ? 0.82 : 1);
        troops(c, ...S(a.x + (b.x - a.x) * q, a.y + (b.y - a.y) * q), Math.atan2(b.y - a.y, b.x - a.x), u, tc, op.kind === "settle" ? 2 : 3, op.battle ? 0 : gt, op.kind === "settle");
        if (op.battle) swords(c, ...S(b.x, b.y), u, gt);
      } else if (op.kind === "ship") {
        const q = this.shipPos(op, p);
        if (op.battle) {
          swords(c, ...S(b.x, b.y), u, gt);
          troops(c, ...S(b.x - Math.cos(q.ang) * 8, b.y - Math.sin(q.ang) * 8), q.ang, u, tc, 3, 0, false);
        } else ship(c, ...S(q.x, q.y), q.ang, u, tc, late, gt);
      } else {
        const q = this.planeAt(op, p);
        c.strokeStyle = "rgba(240,248,255,.5)";
        c.lineWidth = 1.2 * u;
        c.beginPath();
        const s0 = Math.max(0, p - 0.25);
        for (let s = s0; s <= p; s += 0.02) {
          const r = this.planeAt(op, s);
          const [sx, sy] = S(r.x, r.y);
          if (s === s0) c.moveTo(sx, sy);
          else c.lineTo(sx, sy);
        }
        c.stroke();
        plane(c, ...S(q.x, q.y), q.ang, u, tc);
      }
    }
    if (!this.reduce) {
      c.fillStyle = "rgba(240,246,250,.55)";
      for (const s of this.snow) {
        s.y += s.v * 0.016;
        s.x += Math.sin(gt + s.p) * 0.2;
        if (s.y > H) {
          s.y = -3;
          s.x = Math.random() * W;
        }
        dot(c, s.x % W, s.y, s.r);
      }
    }
    const vg = c.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.65);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(2,6,16,.55)");
    c.fillStyle = vg;
    c.fillRect(0, 0, W, H);
  }
}

function dot(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
  c.beginPath();
  c.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  c.fill();
}
function line(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}
function star(c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  c.closePath();
  c.fillStyle = col;
  c.fill();
  c.lineWidth = 1;
  c.strokeStyle = "#06101c";
  c.stroke();
}
/** A little band of soldiers (or settlers with their bundles), bobbing as they march. */
function troops(c: CanvasRenderingContext2D, x: number, y: number, ang: number, u: number, col: string, n: number, walk: number, civil: boolean) {
  const fx = Math.cos(ang) >= 0 ? 1 : -1;
  c.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const px = x + (i - (n - 1) / 2) * 4.2 * u * -fx * 0.6;
    const py = y + (i % 2 ? 2.2 : -1.2) * u - (walk ? Math.abs(Math.sin(walk * 10 + i)) * 1.1 * u : 0);
    c.strokeStyle = "#0a1422";
    c.lineWidth = 2.6 * u;
    line(c, px, py - u, px, py - 5 * u);
    c.strokeStyle = civil ? "#c8b28a" : col;
    c.lineWidth = 1.8 * u;
    line(c, px, py - u, px, py - 5 * u);
    c.fillStyle = "#f2d2b3";
    dot(c, px, py - 6.6 * u, 1.3 * u);
    if (!civil) {
      c.strokeStyle = "#d8dee6";
      c.lineWidth = 0.8 * u;
      line(c, px, py - 4 * u, px + fx * 4 * u, py - 5.5 * u);
    }
  }
}
function swords(c: CanvasRenderingContext2D, x: number, y: number, u: number, gt: number) {
  const s = 1 + 0.15 * Math.sin(gt * 8);
  c.save();
  c.translate(x, y - 12 * u);
  c.scale(s * u, s * u);
  c.fillStyle = "rgba(244,63,94,.9)";
  dot(c, 0, 0, 6.5);
  c.strokeStyle = "#fff";
  c.lineWidth = 1.4;
  c.lineCap = "round";
  line(c, -3.5, -3.5, 3.5, 3.5);
  line(c, 3.5, -3.5, -3.5, 3.5);
  c.restore();
}
/** A sailing ship early on, a steamer with a smoking funnel from the Industrial Age. */
function ship(c: CanvasRenderingContext2D, x: number, y: number, ang: number, u: number, col: string, steam: boolean, gt: number) {
  c.save();
  c.translate(x, y);
  c.rotate(ang);
  c.scale(u, u);
  c.fillStyle = steam ? "#3b4450" : "#6b4f35";
  c.beginPath();
  c.moveTo(-8, -2.6);
  c.lineTo(6, -2.6);
  c.lineTo(10, 0);
  c.lineTo(6, 2.6);
  c.lineTo(-8, 2.6);
  c.closePath();
  c.fill();
  c.fillStyle = col;
  c.fillRect(-6, -1.2, 9, 2.4);
  c.restore();
  if (steam) {
    c.fillStyle = "rgba(200,205,212,.55)";
    for (let k = 0; k < 3; k++) {
      const t = (gt * 1.5 + k / 3) % 1;
      dot(c, x - Math.cos(ang) * (3 + t * 9) * u, y - Math.sin(ang) * (3 + t * 9) * u - t * 6 * u, (1.2 + t * 2.4) * u);
    }
  } else {
    c.fillStyle = "#f1ece0";
    c.beginPath();
    c.moveTo(x, y - u);
    c.lineTo(x, y - 11 * u);
    c.lineTo(x + 6 * u * (Math.cos(ang) >= 0 ? 1 : -1), y - 2 * u);
    c.closePath();
    c.fill();
  }
}
function plane(c: CanvasRenderingContext2D, x: number, y: number, ang: number, u: number, col: string) {
  c.save();
  c.translate(x, y);
  c.rotate(ang);
  c.scale(u * 1.15, u * 1.15);
  c.fillStyle = "rgba(0,0,0,.25)";
  c.beginPath();
  c.ellipse(2, 9, 8, 2, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#d9e1ea";
  for (const pts of [[[9, 0], [-8, -1.3], [-8, 1.3]], [[2, 0], [-3, -8], [-5, -8], [-2, 0], [-5, 8], [-3, 8]], [[-6, 0], [-9, -3.5], [-10, -3.5], [-8.5, 0], [-10, 3.5], [-9, 3.5]]] as const) {
    c.beginPath();
    pts.forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)));
    c.closePath();
    c.fill();
  }
  c.fillStyle = col;
  dot(c, -3.5, -5.5, 1.2);
  dot(c, -3.5, 5.5, 1.2);
  c.restore();
}
