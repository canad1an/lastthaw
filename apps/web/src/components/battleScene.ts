import { FIELD_FILES, castBattlefield, closeRanks, seededRng, type BattleDetailView, type Battlefield, type FieldFigure, type FigureLook } from "@lastthaw/shared";

/**
 * The battle window's painted battlefield: a late-winter field with the attacker's camp on the left and the region's
 * settlement on the right, both armies marching in and meeting in the middle. The fighting itself is scenery (lunges,
 * sparks, arrows, stones, churned mud); the rounds from the server decide who falls. A fallen figure topples, greys,
 * lies in the snow for a while and fades, and the man behind steps up to close the line. Times are on the battle's
 * own clock, seconds since it started, so everyone watching sees the same thing at the same moment.
 */

const W = 1000;
const H = 440;
const HOR = 206;
const FT = 238;
const FB = 422;
const CX = 500;
const COLW = 34;
const GAP = 17;
/** The march in, on a fresh battle. */
const APPROACH = 4.5;
const FALL = 0.55;
/** How long the fallen lie before fading, and how long the fade takes. */
const HOLD = 9;
const FADE = 2.5;

type Pal = Record<"tunic" | "trim" | "cloth" | "skin" | "hair" | "leg" | "wood" | "metal" | "horse" | "horseDark", string>;
const BASE = { skin: "#d9ad8a", hair: "#3b2c22", leg: "#33343b", wood: "#6e5236", metal: "#c3ccd4", horse: "#5a4030", horseDark: "#3b2a1f" };
const PAL: [Pal, Pal] = [
  { ...BASE, tunic: "#c8364a", trim: "#7a1b2a", cloth: "#e5485e" },
  { ...BASE, tunic: "#2d7dbd", trim: "#18466e", cloth: "#3d9be0" },
];
const GREY = "#6c7178";
const FLASH = Object.fromEntries(Object.keys(PAL[0]).map((k) => [k, "#fff4e0"])) as Pal;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (p: number) => 1 - Math.pow(1 - p, 3);
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function mix(a: string, b: string, t: number): string {
  const x = hex(a), y = hex(b);
  return "#" + x.map((v, i) => Math.round(lerp(v, y[i]!, t)).toString(16).padStart(2, "0")).join("");
}
const palCache = new Map<string, Pal>();
function palette(side: 0 | 1, dead: number, flash: boolean): Pal {
  if (flash) return FLASH;
  if (dead <= 0) return PAL[side];
  const q = Math.round(dead * 20);
  const id = `${side}:${q}`;
  let p = palCache.get(id);
  if (!p) {
    p = Object.fromEntries(Object.entries(PAL[side]).map(([k, v]) => [k, mix(v, GREY, (q / 20) * 0.8)])) as Pal;
    palCache.set(id, p);
  }
  return p;
}
const depthOf = (d: number) => ({ y: FT + d * (FB - FT), s: 0.95 + d * 0.75 });
const projX = (x: number, d: number) => CX + (x - CX) * (0.86 + 0.14 * d);
const dirOf = (side: 0 | 1) => (side === 0 ? 1 : -1);
const baseX = (side: 0 | 1, col: number) => CX - dirOf(side) * (GAP + col * COLW);

interface Fig {
  f: FieldFigure;
  x: number;
  d: number;
  tcol: number;
  moving: boolean;
  /** When this figure falls, on the battle clock; Infinity while it stands. */
  fallAt: number;
  shotSent: boolean;
  nextShot: number;
  drawT: number;
  armT: number;
  routAt: number;
  rv: number;
  rd: number;
}
interface Arrow { x0: number; y0: number; x1: number; y1: number; apex: number; t: number; dur: number; s: number; hit: boolean; ang: number }
interface Stone { x0: number; y0: number; x1: number; y1: number; apex: number; t: number; dur: number; s: number; r: number }
interface Spark { x: number; y: number; a: number; len: number; v: number; life: number; max: number; c: string }
interface Puff { x: number; y: number; r: number; grow: number; life: number; max: number; vx: number; c: string }

export class BattleScene {
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private bg: HTMLCanvasElement | null = null;
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver;
  private reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  private battleId = "";
  private startMs = 0;
  private roundS = 6;
  private field: Battlefield = { k: 1, figures: [] };
  private figs: Fig[] = [];
  private known = new Set<number>();
  private endAt = Infinity;
  private attackerWon = false;
  private conquered = false;
  private flagSwapAt = Infinity;
  private totalRounds = 1;
  private t = 0;

  private arrows: Arrow[] = [];
  private stuck: Array<{ x: number; y: number; ang: number; t: number; s: number }> = [];
  private stones: Stone[] = [];
  private sparks: Spark[] = [];
  private puffs: Puff[] = [];
  private smoke: Puff[] = [];
  private craters: Array<{ x: number; y: number; s: number; t: number }> = [];
  private flakes = Array.from({ length: 70 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: 0.5 + Math.random() * 1.1, v: 8 + Math.random() * 14, ph: Math.random() * 6 }));
  private banners: Array<{ side: 0 | 1; file: number; x: number }> = [];

  constructor(private canvas: HTMLCanvasElement, private roundSeconds: number) {
    this.ctx = canvas.getContext("2d")!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
  }

  /** Units per figure, for the caption. */
  get unitsPerFigure() {
    return this.field.k;
  }

  /** Feed the latest battle. The first call places everyone where they would be by now; later rounds play as they arrive. */
  update(b: BattleDetailView) {
    const fresh = b.id !== this.battleId;
    const now = this.clock(Date.parse(b.startedAt));
    if (fresh) {
      this.battleId = b.id;
      this.startMs = Date.parse(b.startedAt);
      this.roundS = this.roundSeconds > 0 ? this.roundSeconds : 6;
      this.known.clear();
      this.endAt = Infinity;
      this.flagSwapAt = Infinity;
      this.arrows = [];
      this.stuck = [];
      this.stones = [];
      this.craters = [];
    }
    this.t = now;
    this.totalRounds = Math.max(1, b.totalRounds);
    this.field = castBattlefield(b.id, b.attacker.start, b.defender.start, b.log);
    const old = new Map(this.figs.map((g) => [g.f.n, g]));
    this.figs = this.field.figures.map((f) => {
      const prev = fresh ? undefined : old.get(f.n);
      let fallAt = Infinity;
      if (f.fallRound !== null) {
        fallAt = f.fallRound * this.roundS + f.stagger;
        // A round that reaches us after its moment plays now rather than jumping ahead; the first look keeps the schedule.
        if (!fresh && !this.known.has(f.n) && fallAt < now) fallAt = now + f.stagger * 0.4;
        if (!fresh && prev && prev.fallAt !== Infinity) fallAt = prev.fallAt;
        this.known.add(f.n);
      }
      const g: Fig = prev ?? { f, x: 0, d: (f.file + 0.5) / FIELD_FILES + f.jd, tcol: f.col0, moving: false, fallAt, shotSent: false, nextShot: 1 + Math.random() * 3, drawT: -9, armT: -9, routAt: Infinity, rv: 60 + Math.random() * 40, rd: (Math.random() - 0.5) * 0.12 };
      g.f = f;
      g.fallAt = fallAt;
      return g;
    });
    if (fresh) {
      // Opening mid-battle: the ranks have already closed up behind whoever has fallen.
      for (const side of [0, 1] as const) {
        const cols = closeRanks(this.field.figures, side, (f) => now < this.figs[f.n]!.fallAt);
        for (const g of this.figs) if (g.f.side === side) g.tcol = cols.get(g.f.n) ?? g.f.col0;
      }
      for (const g of this.figs) g.x = baseX(g.f.side, g.tcol) + g.f.jx + this.offset(g.f.side, now);
      this.banners = [0, 1].flatMap((s) => [1.5, 4.5].map((file) => ({ side: s as 0 | 1, file, x: baseX(s as 0 | 1, 6) + this.offset(s as 0 | 1, now) })));
    }
    if (b.status === "done" && b.result && this.endAt === Infinity) {
      const scheduled = b.totalRounds * this.roundS + 2.4;
      this.endAt = fresh ? scheduled : Math.max(scheduled, now + 1.5);
      this.attackerWon = b.result.attackerWon;
      this.conquered = b.result.conquered;
      if (this.conquered) this.flagSwapAt = this.endAt;
      const loser = this.attackerWon ? 1 : 0;
      for (const g of this.figs) if (g.f.side === loser && g.fallAt === Infinity) g.routAt = this.endAt + Math.random() * 0.8;
      // Opening a battle long over: the beaten have already gone.
      if (now > this.endAt + 15) for (const g of this.figs) if (g.routAt !== Infinity) g.routAt = -Infinity;
    }
  }

  private clock(startMs: number) {
    return (Date.now() - startMs) / 1000;
  }
  private offset(side: 0 | 1, t: number) {
    return -dirOf(side) * (1 - ease(clamp(t / APPROACH, 0, 1))) * 580;
  }
  private screenOf(g: Fig) {
    const { y, s } = depthOf(g.d);
    return { x: projX(g.x, g.d), y, s };
  }
  private standing(g: Fig, t: number) {
    return t < g.fallAt && !(t >= g.routAt);
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 10) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round((this.canvas.width * H) / W);
    this.scale = this.canvas.width / W;
    this.bg = paintBackground(this.canvas.width, this.canvas.height, this.scale);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.last) / 1000);
    this.last = nowMs;
    if (this.battleId) {
      this.t = this.clock(this.startMs);
      this.step(dt);
      this.draw();
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private step(dt: number) {
    const t = this.t;
    const ended = t >= this.endAt;
    const fighting = t >= APPROACH - 0.4 && !ended;
    for (const side of [0, 1] as const) {
      const dir = dirOf(side);
      const cols = closeRanks(this.field.figures, side, (f) => this.standing(this.figs[f.n]!, t));
      const off = this.offset(side, t);
      let maxCol = 0;
      for (const g of this.figs) {
        if (g.f.side !== side) continue;
        if (this.standing(g, t)) {
          g.tcol = cols.get(g.f.n) ?? g.tcol;
          if (g.f.look.cat !== "siege") maxCol = Math.max(maxCol, g.tcol);
          const tx = baseX(side, g.tcol) + g.f.jx + off;
          if (t < APPROACH || g.f.look.cat === "siege") g.x = tx;
          else g.x += clamp(tx - g.x, -26 * dt, 26 * dt);
          g.moving = t < APPROACH || Math.abs(tx - g.x) > 0.4;
          if (fighting && t > APPROACH) this.shoot(g, t);
        } else if (t >= g.routAt) {
          g.x -= dir * g.rv * dt;
          g.d = clamp(g.d + g.rd * dt, 0.02, 0.98);
        }
        // The moment of a fall: sparks off the blow and a puff of snow.
        if (g.fallAt !== Infinity && t >= g.fallAt && t - dt < g.fallAt) {
          const p = this.screenOf(g);
          this.burst(p.x + dir * 6 * p.s, p.y - 15 * p.s, 7);
          this.puff(p.x, p.y, 0.8);
        }
        // Arrows and shots find the archers and gunners who are about to fall.
        if (g.f.look.cat === "ranged" && g.fallAt !== Infinity && !g.shotSent && t >= g.fallAt - 1.1 && t < g.fallAt) {
          g.shotSent = true;
          const shooter = this.figs.find((s) => s.f.side !== side && s.f.look.cat === "ranged" && this.standing(s, t));
          if (shooter) this.fire(shooter, g, g.fallAt - t, true);
        }
      }
      const bx = baseX(side, maxCol + 0.9) + off;
      for (const b of this.banners) if (b.side === side) b.x = t < APPROACH ? bx : b.x + clamp(bx - b.x, -26 * dt, 26 * dt);
    }

    if (fighting && t > APPROACH - 0.2 && !this.reduce) {
      for (let file = 0; file < FIELD_FILES; file++) {
        const a = this.figs.find((g) => g.f.side === 0 && g.f.file === file && g.tcol === 0 && g.f.look.cat !== "siege" && this.standing(g, t));
        const d = this.figs.find((g) => g.f.side === 1 && g.f.file === file && g.tcol === 0 && g.f.look.cat !== "siege" && this.standing(g, t));
        if (!a || !d) continue;
        const pa = this.screenOf(a), pd = this.screenOf(d);
        if (Math.random() < dt * 2.4) this.burst((pa.x + pd.x) / 2, pa.y - (12 + Math.random() * 8) * pa.s, 4);
        if (Math.random() < dt * 0.9) this.puff((pa.x + pd.x) / 2 + (Math.random() - 0.5) * 10, pa.y, 1);
      }
    }

    for (const a of this.arrows) {
      a.t += dt / a.dur;
      if (a.t >= 1 && !a.hit) this.stuck.push({ x: a.x1, y: a.y1, ang: a.ang, t, s: a.s });
    }
    this.arrows = this.arrows.filter((a) => a.t < 1);
    this.stuck = this.stuck.filter((a) => t - a.t < 6 && t >= a.t);
    for (const st of this.stones) {
      st.t += dt / st.dur;
      if (st.t >= 1) {
        for (let i = 0; i < 3; i++) this.puff(st.x1 + (Math.random() - 0.5) * 16, st.y1, 1.6);
        this.craters.push({ x: st.x1, y: st.y1, s: st.s, t });
        this.burst(st.x1, st.y1 - 3, 5, "#d8dfe4");
      }
    }
    this.stones = this.stones.filter((s) => s.t < 1);
    this.craters = this.craters.filter((c) => t - c.t < 14 && t >= c.t);
    for (const p of this.sparks) p.life -= dt;
    this.sparks = this.sparks.filter((p) => p.life > 0);
    for (const p of this.puffs) {
      p.life -= dt;
      p.r += dt * p.grow;
      p.y -= dt * 6;
      p.x += dt * p.vx;
    }
    this.puffs = this.puffs.filter((p) => p.life > 0);
    if (Math.random() < dt * 2.2) this.smoke.push({ x: 948 + (Math.random() - 0.5) * 4, y: HOR - 30, r: 3, grow: 2.2, life: 6, max: 6, vx: 3.5, c: "" });
    if (Math.random() < dt * 1.6) this.smoke.push({ x: 92 + (Math.random() - 0.5) * 4, y: HOR + 6, r: 2.5, grow: 2.2, life: 5, max: 5, vx: 3.5, c: "" });
    for (const p of this.smoke) {
      p.life -= dt;
      p.y -= dt * 7;
      p.x += dt * p.vx;
      p.r += dt * p.grow;
    }
    this.smoke = this.smoke.filter((p) => p.life > 0);
    if (!this.reduce)
      for (const fl of this.flakes) {
        fl.y += fl.v * dt;
        fl.x += Math.sin(t * 0.8 + fl.ph) * 6 * dt - 3 * dt;
        if (fl.y > H) {
          fl.y = -2;
          fl.x = Math.random() * W;
        }
        if (fl.x < 0) fl.x += W;
      }
  }

  /** Archers and gunners loose every few seconds at someone across the field; siege engines throw now and then. */
  private shoot(g: Fig, t: number) {
    const cat = g.f.look.cat;
    if (cat !== "ranged" && cat !== "siege") return;
    if (t < g.nextShot + APPROACH) return;
    const foes = this.figs.filter((x) => x.f.side !== g.f.side && x.f.look.cat !== "siege" && this.standing(x, t));
    if (!foes.length) return;
    if (cat === "ranged") {
      g.nextShot = t - APPROACH + 2.6 + Math.random() * 2;
      this.fire(g, foes[Math.floor(Math.random() * foes.length)]!, 1 + Math.random() * 0.3, false);
      return;
    }
    if (t < APPROACH + 1) return;
    g.nextShot = t - APPROACH + 5 + Math.random() * 3;
    g.armT = t;
    const back = [...foes].sort((a, b) => b.tcol - a.tcol).slice(0, 12);
    const target = back[Math.floor(Math.random() * back.length)]!;
    const p = this.screenOf(g), q = this.screenOf(target);
    const cannon = g.f.look.weapon === "cannon";
    if (cannon) {
      this.burst(p.x + dirOf(g.f.side) * 16 * p.s, p.y - 9 * p.s, 6, "#ffd28a");
      this.puff(p.x + dirOf(g.f.side) * 16 * p.s, p.y - 6 * p.s, 1.6, "rgba(200,200,205,");
    }
    this.stones.push({ x0: p.x + dirOf(g.f.side) * 10 * p.s, y0: p.y - (cannon ? 9 : 28) * p.s, x1: q.x + (Math.random() - 0.5) * 30, y1: q.y + (Math.random() - 0.5) * 10, apex: cannon ? 30 : 150 + Math.random() * 40, t: cannon ? 0 : -0.35 / 1.8, dur: cannon ? 0.7 : 1.8, s: q.s, r: cannon ? 2 : 2.6 });
  }

  private fire(g: Fig, target: Fig, dur: number, hit: boolean) {
    g.drawT = this.t;
    const p = this.screenOf(g), q = this.screenOf(target);
    const dir = dirOf(g.f.side);
    if (g.f.look.weapon === "gun") {
      this.burst(p.x + dir * 13 * p.s, p.y - 16 * p.s, 4, "#ffd28a");
      this.puff(p.x + dir * 14 * p.s, p.y - 15 * p.s, 0.7, "rgba(210,210,214,");
      return;
    }
    const x1 = q.x + (hit ? 0 : (Math.random() - 0.5) * 18);
    const y1 = hit ? q.y - 14 * q.s : q.y - Math.random() * 3;
    this.arrows.push({ x0: p.x + dir * 6 * p.s, y0: p.y - 17 * p.s, x1, y1, apex: 46 + Math.random() * 40 + Math.abs(x1 - p.x) * 0.15, t: 0, dur: Math.max(0.3, dur), s: (p.s + q.s) / 2, hit, ang: 0 });
  }

  private burst(x: number, y: number, n: number, color?: string) {
    if (this.reduce) return;
    for (let i = 0; i < n; i++) this.sparks.push({ x, y, a: Math.random() * Math.PI * 2, len: 2 + Math.random() * 4, v: 30 + Math.random() * 40, life: 0.18 + Math.random() * 0.15, max: 0.33, c: color ?? (Math.random() < 0.6 ? "#fff6d5" : "#ffc46b") });
  }
  private puff(x: number, y: number, size: number, c = "rgba(226,232,236,") {
    this.puffs.push({ x, y: y - 2, r: 3 * size, grow: 9 * size, life: 1.3, max: 1.3, vx: (Math.random() - 0.5) * 8, c });
  }

  private draw() {
    const c = this.ctx, t = this.t;
    if (!this.bg) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.bg, 0, 0);
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    // The settlement's flag: the defender's colour, the attacker's once the region falls.
    {
      const side: 0 | 1 = t >= this.flagSwapAt ? 0 : 1;
      const lift = t >= this.flagSwapAt ? clamp((t - this.flagSwapAt) / 1.5, 0, 1) : 1;
      c.strokeStyle = "#3a2c20";
      c.lineWidth = 1.2;
      line(c, 948, HOR - 58, 948, HOR - 84);
      c.fillStyle = PAL[side].cloth;
      const top = HOR - 84 + (1 - lift) * 20;
      c.beginPath();
      c.moveTo(948, top);
      for (let i = 0; i <= 5; i++) c.lineTo(948 + i * 3, top + Math.sin(t * 3 + i) * 1.2);
      for (let i = 5; i >= 0; i--) c.lineTo(948 + i * 3, top + 9 + Math.sin(t * 3 + i) * 1.2);
      c.fill();
    }
    for (const p of this.smoke) {
      c.fillStyle = `rgba(190,196,204,${0.28 * (p.life / p.max)})`;
      dot(c, p.x, p.y, p.r);
    }
    // The middle of the field churns to mud as the battle goes on.
    if (t > APPROACH) {
      const prog = clamp((t - APPROACH) / (this.totalRounds * this.roundS), 0, 1);
      c.save();
      c.translate(CX, (FT + FB) / 2 + 6);
      c.scale(1, 0.62);
      const rx = 70 + prog * 90;
      const gr = c.createRadialGradient(0, 0, 0, 0, 0, rx + 60);
      gr.addColorStop(0, `rgba(88,70,54,${0.25 + prog * 0.35})`);
      gr.addColorStop(0.6, `rgba(98,80,62,${0.12 + prog * 0.2})`);
      gr.addColorStop(1, "rgba(98,80,62,0)");
      c.fillStyle = gr;
      c.fillRect(-rx - 60, -200, (rx + 60) * 2, 400);
      c.restore();
    }
    for (const cr of this.craters) {
      c.fillStyle = `rgba(80,66,52,${0.5 * (1 - (t - cr.t) / 14)})`;
      c.beginPath();
      c.ellipse(cr.x, cr.y, 9 * cr.s, 2.6 * cr.s, 0, 0, Math.PI * 2);
      c.fill();
    }

    const items: Array<{ y: number; fn: () => void }> = [];
    for (const g of this.figs) {
      if (t >= g.fallAt + FALL + HOLD + FADE) continue;
      if (t >= g.routAt && (g.x < -80 || g.x > W + 80)) continue;
      items.push({ y: depthOf(g.d).y - (t >= g.fallAt ? 0.5 : 0), fn: () => this.drawFig(c, g) });
    }
    const losing = t >= this.endAt ? (this.attackerWon ? 1 : 0) : -1;
    for (const b of this.banners) if (b.side !== losing) items.push({ y: depthOf((b.file + 0.5) / FIELD_FILES).y, fn: () => drawBanner(c, b.side, b.x, (b.file + 0.5) / FIELD_FILES, t) });
    for (const a of this.stuck)
      items.push({
        y: a.y,
        fn: () => {
          c.strokeStyle = `rgba(70,52,36,${1 - clamp((t - a.t - 4) / 2, 0, 1)})`;
          c.lineWidth = 0.9;
          c.save();
          c.translate(a.x, a.y);
          c.rotate(a.ang);
          line(c, -5 * a.s, 0, 1, 0);
          c.restore();
        },
      });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.fn();

    for (const a of this.arrows) {
      const p = clamp(a.t, 0, 1);
      const x = lerp(a.x0, a.x1, p), y = lerp(a.y0, a.y1, p) - a.apex * 4 * p * (1 - p);
      a.ang = Math.atan2(a.y1 - a.y0 - a.apex * 4 * (1 - 2 * p), a.x1 - a.x0);
      c.save();
      c.translate(x, y);
      c.rotate(a.ang);
      c.strokeStyle = "#3d3024";
      c.lineWidth = 0.9;
      line(c, -8 * a.s, 0, 0, 0);
      c.fillStyle = "#c8d0d6";
      c.beginPath();
      c.moveTo(0, -1);
      c.lineTo(2.2, 0);
      c.lineTo(0, 1);
      c.fill();
      c.strokeStyle = "#e6e2d8";
      c.lineWidth = 0.8;
      line(c, -8 * a.s, 0, -9.5 * a.s, -1.4);
      line(c, -8 * a.s, 0, -9.5 * a.s, 1.4);
      c.restore();
    }
    for (const st of this.stones) {
      if (st.t < 0) continue;
      const p = clamp(st.t, 0, 1);
      const x = lerp(st.x0, st.x1, p), y = lerp(st.y0, st.y1, p) - st.apex * 4 * p * (1 - p);
      c.fillStyle = "#6f7378";
      dot(c, x, y, st.r + st.s);
    }
    for (const p of this.puffs) {
      c.fillStyle = `${p.c}${0.4 * (p.life / p.max)})`;
      dot(c, p.x, p.y, p.r);
    }
    c.lineCap = "round";
    for (const p of this.sparks) {
      const a = p.life / p.max, dist = (1 - a) * p.v * 0.33;
      c.strokeStyle = p.c;
      c.globalAlpha = a;
      c.lineWidth = 1;
      line(c, p.x + Math.cos(p.a) * dist, p.y + Math.sin(p.a) * dist, p.x + Math.cos(p.a) * (dist + p.len), p.y + Math.sin(p.a) * (dist + p.len));
    }
    c.globalAlpha = 1;
    if (!this.reduce) {
      c.fillStyle = "rgba(245,248,250,.7)";
      for (const fl of this.flakes) dot(c, fl.x, fl.y, fl.r);
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    const cw = this.canvas.width, ch = this.canvas.height;
    const vg = c.createRadialGradient(cw / 2, ch * 0.55, ch * 0.35, cw / 2, ch * 0.55, cw * 0.62);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(2,6,23,.45)");
    c.fillStyle = vg;
    c.fillRect(0, 0, cw, ch);
  }

  private drawFig(c: CanvasRenderingContext2D, g: Fig) {
    const t = this.t, f = g.f, look = f.look, side = f.side;
    const { x, y, s } = this.screenOf(g);
    let face = dirOf(side), alpha = 1, dead = 0, flash = false, fallP = 0;
    if (t >= g.fallAt) {
      fallP = clamp((t - g.fallAt) / FALL, 0, 1);
      flash = t - g.fallAt < 0.12;
      dead = fallP;
      alpha = 1 - clamp((t - g.fallAt - FALL - HOLD) / FADE, 0, 1);
    }
    const routing = t >= g.routAt;
    if (routing) face = -face;
    const ended = t >= this.endAt;
    const up = this.standing(g, t);
    const o = { walk: t * (routing ? 16 : 10) + f.ph, moving: g.moving || routing, swing: 0, thrust: 0, raise: false, draw: 0, brace: 0, rear: 0, arm: 0 };
    let dx = 0, dy = 0;
    if (up) {
      const engaged = !ended && t > APPROACH - 0.3 && g.tcol === 0 && look.cat !== "siege";
      const ph = t * 5 + f.ph;
      if (engaged) {
        const l = Math.max(0, Math.sin(ph));
        dx = l * 3.4;
        o.swing = Math.sin(ph + 0.7);
        o.thrust = l;
        o.brace = 1;
        o.rear = look.cat === "horse" ? Math.max(0, Math.sin(t * 2 + f.ph)) : 0;
      } else if (t > APPROACH) {
        o.swing = Math.sin(t * 1.4 + f.ph) * 0.15;
        dy = Math.sin(t * 2 + f.ph) * 0.4;
      }
      // The winners raise their weapons for a while once it is over.
      if (ended && t < this.endAt + 20 && look.cat !== "siege" && g.routAt === Infinity) {
        o.raise = true;
        o.moving = false;
        dx = 0;
        dy = -Math.abs(Math.sin(t * 5 + f.ph)) * 2.6;
      }
      if (look.cat === "ranged") o.draw = clamp(1 - (t - g.drawT) / 0.45, 0, 1);
      if (look.cat === "siege") {
        const since = t - g.armT;
        o.arm = since < 0.35 ? 0 : since < 0.6 ? ease((since - 0.35) / 0.25) : since < 3 ? 1 - clamp((since - 1.2) / 1.8, 0, 1) : 0;
      }
    }
    const P = palette(side, dead, flash);
    c.save();
    c.globalAlpha = alpha;
    c.translate(x, y);
    if (fallP > 0) {
      // A dark stain in the snow under the fallen.
      c.fillStyle = `rgba(70,28,24,${0.38 * fallP})`;
      c.beginPath();
      c.ellipse(-face * f.fb * 10 * s, 1, 13 * s * fallP, 3 * s * fallP, 0, 0, Math.PI * 2);
      c.fill();
    }
    const big = look.cat === "siege" ? 1.15 : 1;
    c.scale(s * face * big, s * big);
    c.translate(dx, dy);
    if (fallP > 0) {
      const e = fallP * fallP;
      c.translate(-f.fb * 3 * e, 0);
      if (look.cat === "horse" || look.cat === "siege") {
        c.rotate(-f.fb * 0.18 * e);
        c.scale(1, 1 - 0.55 * e);
      } else c.rotate((-f.fb * e * Math.PI) / 2);
    }
    if (look.cat === "horse") drawHorse(c, P, look, o, t);
    else if (look.cat === "siege") (look.weapon === "cannon" ? drawCannon : drawCatapult)(c, P, o);
    else drawFoot(c, P, look, o);
    c.restore();
  }
}

type Pose = { walk: number; moving: boolean; swing: number; thrust: number; raise: boolean; draw: number; brace: number; rear: number; arm: number };

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
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

function drawFoot(c: CanvasRenderingContext2D, P: Pal, look: FigureLook, o: Pose) {
  c.lineCap = "round";
  c.lineJoin = "round";
  const lx = o.moving ? Math.sin(o.walk) * 3.6 : 1.7 + o.brace;
  c.strokeStyle = P.leg;
  c.lineWidth = 2.6;
  c.beginPath();
  c.moveTo(0, -10);
  c.lineTo(lx, 0);
  c.moveTo(0, -10);
  c.lineTo(-lx, 0);
  c.stroke();
  c.fillStyle = look.cat === "civil" ? P.wood : P.tunic;
  rr(c, -3.8, -20, 7.6, 11, 2.2);
  c.fill();
  c.fillStyle = P.trim;
  c.fillRect(-3.8, -11.6, 7.6, 1.6);
  c.fillStyle = P.skin;
  dot(c, 0.4, -23.4, 3.2);
  if (look.helm) {
    c.fillStyle = P.metal;
    c.beginPath();
    c.arc(0.4, -23.8, 3.5, Math.PI, Math.PI * 2);
    c.fill();
    c.fillRect(-3.1, -24.2, 7, 1.2);
  } else {
    c.fillStyle = P.hair;
    c.beginPath();
    c.arc(0.2, -24, 3.4, Math.PI * 1.05, Math.PI * 1.95);
    c.fill();
  }
  const w = look.weapon, sw = o.swing;
  c.strokeStyle = P.tunic;
  c.lineWidth = 2.2;
  if (w === "spear") {
    const hx = 4 + o.thrust * 4, hy = -15, a = o.raise ? -1.25 : -0.16 + sw * 0.05;
    line(c, 1, -18, hx, hy);
    c.save();
    c.translate(hx, hy);
    c.rotate(a);
    c.strokeStyle = P.wood;
    c.lineWidth = 1.5;
    line(c, -10, 0, 17, 0);
    c.fillStyle = P.metal;
    c.beginPath();
    c.moveTo(17, -1.8);
    c.lineTo(22, 0);
    c.lineTo(17, 1.8);
    c.fill();
    c.restore();
  } else if (w === "sword" || w === "club" || w === "axe" || w === "sling") {
    const a = o.raise ? -1.5 : -1.35 + (sw + 1) * 0.95;
    const hx = 3 + Math.cos(a) * 2, hy = -16 + Math.sin(a) * 2;
    line(c, 1, -18, hx, hy);
    c.save();
    c.translate(hx, hy);
    c.rotate(a);
    if (w === "sword") {
      c.strokeStyle = P.metal;
      c.lineWidth = 1.7;
      line(c, 1, 0, 11, 0);
      c.strokeStyle = P.trim;
      c.lineWidth = 1.6;
      line(c, 1, -2.2, 1, 2.2);
    } else if (w === "club") {
      c.strokeStyle = P.wood;
      c.lineWidth = 2;
      line(c, 0, 0, 9, 0);
      c.fillStyle = P.wood;
      dot(c, 9.5, 0, 2.2);
    } else if (w === "axe") {
      c.strokeStyle = P.wood;
      c.lineWidth = 1.5;
      line(c, 0, 0, 10, 0);
      c.fillStyle = P.metal;
      c.beginPath();
      c.moveTo(8, -0.5);
      c.lineTo(11, -3.6);
      c.lineTo(12, 1);
      c.fill();
    } else {
      c.strokeStyle = P.wood;
      c.lineWidth = 0.8;
      line(c, 0, 0, 7, 0);
      c.fillStyle = "#8b8f94";
      dot(c, 7.5, 0, 1.4);
    }
    c.restore();
  } else if (w === "bow") {
    line(c, 1, -18, 6, -17);
    c.strokeStyle = P.wood;
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(4.5, -17, 7, -1.2, 1.2);
    c.stroke();
    const ex = 4.5 + Math.cos(1.2) * 7, ey = Math.sin(1.2) * 7;
    c.strokeStyle = "rgba(230,230,230,.75)";
    c.lineWidth = 0.6;
    c.beginPath();
    c.moveTo(ex, -17 - ey);
    c.lineTo(ex - o.draw * 4.5, -17);
    c.lineTo(ex, -17 + ey);
    c.stroke();
    c.fillStyle = P.wood;
    c.save();
    c.translate(-3.6, -17);
    c.rotate(-0.4);
    c.fillRect(-1.3, -4, 2.6, 8);
    c.restore();
  } else if (w === "gun") {
    const a = o.raise ? -1.2 : -0.08;
    line(c, 1, -18, 5, -16);
    c.save();
    c.translate(4, -16);
    c.rotate(a);
    c.strokeStyle = P.wood;
    c.lineWidth = 2;
    line(c, -5, 0, 3, 0);
    c.strokeStyle = "#4b5056";
    c.lineWidth = 1.3;
    line(c, 2, 0, 12, 0);
    c.restore();
  } else if (look.cat === "civil") {
    // A bundle on the back.
    c.fillStyle = P.wood;
    rr(c, -7.5, -21, 4.5, 7, 1.5);
    c.fill();
  }
  if (look.shield) {
    c.fillStyle = P.trim;
    c.beginPath();
    c.ellipse(4.8, -14.5, 2.7, 5.6, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = P.cloth;
    c.lineWidth = 0.9;
    c.stroke();
    c.fillStyle = P.metal;
    dot(c, 5.2, -14.5, 0.9);
  }
}

function drawHorse(c: CanvasRenderingContext2D, P: Pal, look: FigureLook, o: Pose, t: number) {
  c.lineCap = "round";
  c.lineJoin = "round";
  const m = o.moving ? 3.2 : 0.8;
  c.strokeStyle = P.horseDark;
  c.lineWidth = 2;
  for (const [x, k] of [[-7, 0], [-4.5, 2], [5, 1], [7.5, 3]] as const) line(c, x, -11, x + Math.sin(o.walk + k) * m, 0);
  c.lineWidth = 2.2;
  c.beginPath();
  c.moveTo(-10, -15);
  c.quadraticCurveTo(-15, -12, -13.5, -6);
  c.stroke();
  c.fillStyle = P.horse;
  c.beginPath();
  c.ellipse(0, -14, 10.5, 5, 0, 0, Math.PI * 2);
  c.fill();
  c.save();
  c.translate(7, -16);
  c.rotate(-o.rear * 0.25);
  c.beginPath();
  c.moveTo(-1, 0);
  c.lineTo(2.5, 3.5);
  c.lineTo(7.5, -6);
  c.lineTo(4, -9);
  c.closePath();
  c.fill();
  c.translate(7.4, -7.6);
  c.rotate(0.55);
  c.beginPath();
  c.ellipse(0, 0, 4, 2.1, 0, 0, Math.PI * 2);
  c.fill();
  c.restore();
  c.fillStyle = P.cloth;
  rr(c, -6.5, -18, 11, 6.5, 1.5);
  c.fill();
  c.fillStyle = P.trim;
  c.fillRect(-6.5, -12.6, 11, 1.2);
  c.strokeStyle = P.leg;
  c.lineWidth = 2;
  line(c, -0.5, -18, 1, -12.5);
  c.fillStyle = P.tunic;
  rr(c, -3, -28.5, 6.2, 10.5, 2);
  c.fill();
  c.fillStyle = P.skin;
  dot(c, 0.2, -31.6, 3);
  c.fillStyle = look.helm ? P.metal : P.hair;
  c.beginPath();
  c.arc(0.2, -32, 3.3, Math.PI, Math.PI * 2);
  c.fill();
  c.save();
  c.translate(2 + o.thrust * 3, -24);
  c.rotate(o.raise ? -0.9 : -0.1 + o.swing * 0.06);
  c.strokeStyle = P.wood;
  c.lineWidth = 1.5;
  line(c, -9, 0, 22, 0);
  c.fillStyle = P.metal;
  c.beginPath();
  c.moveTo(22, -1.5);
  c.lineTo(26, 0);
  c.lineTo(22, 1.5);
  c.fill();
  c.fillStyle = P.cloth;
  c.beginPath();
  c.moveTo(16, 0);
  c.lineTo(11, -3 + Math.sin(t * 9) * 0.8);
  c.lineTo(11, 0);
  c.fill();
  c.restore();
}

function drawCatapult(c: CanvasRenderingContext2D, P: Pal, o: Pose) {
  c.lineCap = "round";
  const dk = mix(P.wood, "#000000", 0.35);
  c.fillStyle = P.wood;
  c.fillRect(-15, -7.5, 30, 3.6);
  c.fillStyle = dk;
  dot(c, -10, -3.4, 3.4);
  dot(c, 10, -3.4, 3.4);
  c.strokeStyle = P.wood;
  c.lineWidth = 2.2;
  line(c, -5, -7, 0, -17);
  line(c, 5, -7, 0, -17);
  const ang = lerp(Math.PI - 0.35, 2 * Math.PI - 1.05, o.arm);
  const ex = Math.cos(ang) * 19, ey = -17 + Math.sin(ang) * 19;
  c.strokeStyle = dk;
  c.lineWidth = 2.4;
  line(c, 0, -17, ex, ey);
  c.fillStyle = dk;
  dot(c, ex, ey, 2.4);
  if (o.arm < 0.05) {
    c.fillStyle = "#8b8f94";
    dot(c, ex, ey - 1.6, 1.8);
  }
  c.fillStyle = P.cloth;
  c.fillRect(-14, -10.5, 6, 3);
}

function drawCannon(c: CanvasRenderingContext2D, P: Pal, o: Pose) {
  const dk = mix(P.wood, "#000000", 0.35);
  c.save();
  c.translate(-o.arm * 2, 0);
  c.fillStyle = P.wood;
  c.beginPath();
  c.moveTo(-14, -4);
  c.lineTo(4, -8);
  c.lineTo(4, -4);
  c.closePath();
  c.fill();
  c.strokeStyle = "#3f4449";
  c.lineWidth = 4;
  c.lineCap = "round";
  line(c, -4, -9, 15, -11);
  c.fillStyle = dk;
  dot(c, 0, -4, 4.4);
  c.fillStyle = P.cloth;
  c.fillRect(-13, -7, 5, 2.4);
  c.restore();
}

function drawBanner(c: CanvasRenderingContext2D, side: 0 | 1, x: number, d: number, t: number) {
  const { y, s } = depthOf(d);
  const dir = dirOf(side);
  c.save();
  c.translate(projX(x, d), y);
  c.scale(s, s);
  c.strokeStyle = "#4a3726";
  c.lineWidth = 1.6;
  line(c, 0, 0, 0, -50);
  c.fillStyle = PAL[side].cloth;
  c.beginPath();
  c.moveTo(0, -49);
  for (let i = 0; i <= 6; i++) c.lineTo(dir * i * 2.6, -49 + Math.sin(t * 3 + i * 0.8) * 1.4);
  for (let i = 6; i >= 0; i--) c.lineTo(dir * i * 2.6, -37 + Math.sin(t * 3 + i * 0.8) * 1.4);
  c.fill();
  c.strokeStyle = "rgba(255,255,255,.85)";
  c.lineWidth = 1.2;
  c.beginPath();
  if (side === 0) {
    c.moveTo(dir * 4, -46);
    c.lineTo(dir * 8, -42);
    c.lineTo(dir * 12, -46);
  } else {
    c.moveTo(dir * 3, -43);
    c.quadraticCurveTo(dir * 6, -46, dir * 8, -43);
    c.quadraticCurveTo(dir * 10, -40, dir * 13, -43);
  }
  c.stroke();
  c.restore();
}

/** The still parts of the field: sky, mountains, pines, the thawing ground, the camp and the settlement. */
function paintBackground(width: number, height: number, scale: number): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  const g = el.getContext("2d")!;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  const r = seededRng("battlefield-backdrop");
  let gr = g.createLinearGradient(0, 0, 0, HOR);
  gr.addColorStop(0, "#18212f");
  gr.addColorStop(0.55, "#38475b");
  gr.addColorStop(1, "#8796a7");
  g.fillStyle = gr;
  g.fillRect(0, 0, W, HOR + 2);
  gr = g.createRadialGradient(380, HOR - 18, 4, 380, HOR - 18, 260);
  gr.addColorStop(0, "rgba(240,206,160,.55)");
  gr.addColorStop(1, "rgba(240,206,160,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, W, HOR + 2);
  const range = (base: number, amp: number, step: number, color: string, snow: string | null) => {
    g.beginPath();
    g.moveTo(0, HOR + 2);
    let y = base;
    const pts: Array<[number, number]> = [];
    for (let x = 0; x <= W + step; x += step) {
      y = clamp(y + (r() - 0.5) * amp, base - amp * 1.8, base + amp * 0.6);
      pts.push([x, y]);
      g.lineTo(x, y);
    }
    g.lineTo(W, HOR + 2);
    g.closePath();
    g.fillStyle = color;
    g.fill();
    if (snow) {
      g.save();
      g.clip();
      g.fillStyle = snow;
      for (const [x, yy] of pts)
        if (yy < base - amp * 0.5) {
          g.beginPath();
          g.moveTo(x - step * 0.9, yy + 10);
          g.lineTo(x, yy - 1);
          g.lineTo(x + step * 0.9, yy + 10);
          g.fill();
        }
      g.restore();
    }
  };
  range(HOR - 60, 26, 26, "#66788d", "rgba(226,234,240,.55)");
  range(HOR - 30, 18, 18, "#4f6074", "rgba(220,228,236,.35)");
  range(HOR - 10, 8, 14, "#3e4c5c", null);
  g.fillStyle = "#2b3744";
  for (let x = 0; x < W; x += 6 + r() * 14) {
    if (x > 150 && x < 840 && r() < 0.6) continue;
    const h = 8 + r() * 12, y = HOR - 2 + r() * 4;
    g.beginPath();
    g.moveTo(x, y - h);
    g.lineTo(x + h * 0.32, y);
    g.lineTo(x - h * 0.32, y);
    g.fill();
  }
  gr = g.createLinearGradient(0, HOR, 0, H);
  gr.addColorStop(0, "#8e9ca6");
  gr.addColorStop(0.3, "#b3c0c8");
  gr.addColorStop(1, "#dbe2e6");
  g.fillStyle = gr;
  g.fillRect(0, HOR, W, H - HOR);
  for (let i = 0; i < 70; i++) {
    const d = r(), y = HOR + 6 + d * d * (H - HOR), s = 0.3 + d * 1.2, x = r() * W, kind = r();
    g.fillStyle = kind < 0.55 ? `rgba(107,88,68,${0.18 + r() * 0.3})` : kind < 0.8 ? `rgba(160,190,208,${0.35 + r() * 0.3})` : "rgba(240,245,248,.5)";
    g.beginPath();
    g.ellipse(x, y, (14 + r() * 40) * s, (2 + r() * 5) * s, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = "rgba(74,70,52,.45)";
  g.lineWidth = 1;
  for (let i = 0; i < 160; i++) {
    const d = r(), y = HOR + 8 + d * (H - HOR - 8), x = r() * W, h = 2 + d * 4;
    line(g, x, y, x - 1, y - h);
    line(g, x, y, x + 1.5, y - h * 0.8);
  }
  for (const [x, w] of [[30, 26], [62, 22], [118, 24], [146, 18]] as const) {
    const y = HOR + 8;
    g.fillStyle = "#8b7a62";
    g.beginPath();
    g.moveTo(x - w / 2, y);
    g.lineTo(x, y - w * 0.7);
    g.lineTo(x + w / 2, y);
    g.fill();
    g.fillStyle = "#6a5c48";
    g.beginPath();
    g.moveTo(x, y - w * 0.7);
    g.lineTo(x + w / 2, y);
    g.lineTo(x + 2, y);
    g.fill();
    g.fillStyle = "#a3384a";
    g.fillRect(x - w * 0.33, y - w * 0.3, w * 0.66, 2);
  }
  gr = g.createRadialGradient(92, HOR + 7, 1, 92, HOR + 7, 16);
  gr.addColorStop(0, "rgba(255,170,90,.9)");
  gr.addColorStop(1, "rgba(255,170,90,0)");
  g.fillStyle = gr;
  g.fillRect(70, HOR - 10, 44, 30);
  for (const [x, w] of [[880, 26], [910, 30], [975, 28]] as const) {
    g.fillStyle = "#4b3b2d";
    g.beginPath();
    g.moveTo(x - w / 2, HOR - 6);
    g.lineTo(x, HOR - 6 - w * 0.55);
    g.lineTo(x + w / 2, HOR - 6);
    g.fill();
  }
  g.fillStyle = "#5d4835";
  g.fillRect(940, HOR - 46, 16, 48);
  g.fillStyle = "#3f3024";
  g.beginPath();
  g.moveTo(936, HOR - 46);
  g.lineTo(948, HOR - 58);
  g.lineTo(960, HOR - 46);
  g.fill();
  g.fillStyle = "#251c15";
  g.fillRect(945, HOR - 38, 6, 6);
  for (let x = 852; x < W + 4; x += 4.2) {
    if (x > 896 && x < 908) continue;
    const h = 20 + r() * 4;
    g.fillStyle = r() < 0.5 ? "#604a36" : "#56422f";
    g.beginPath();
    g.moveTo(x, HOR + 10);
    g.lineTo(x, HOR + 10 - h);
    g.lineTo(x + 2, HOR + 10 - h - 3);
    g.lineTo(x + 4, HOR + 10 - h);
    g.lineTo(x + 4, HOR + 10);
    g.fill();
  }
  g.fillStyle = "#2b211a";
  g.fillRect(896, HOR - 6, 12, 16);
  return el;
}
