import { useEffect, useRef, useState } from "react";
import { AGES } from "@lastthaw/shared";
import { HERO_DAYS, HeroWar, ageOn } from "./heroWar.js";

/**
 * The home page's match in a minute, on the real map: tribes claim land, conquer their neighbours, sail fleets and
 * fly bombers while the ice closes in, with a caption for each stage of the game and a ticker of the big moments.
 * It only runs while on screen; with reduced motion it shows one still frame from late in a match.
 */
export function HeroMap({ className = "" }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cap, setCap] = useState({ big: "", small: "", n: 0 });
  const [news, setNews] = useState<Array<{ id: number; text: string; color: string }>>([]);
  const [hud, setHud] = useState({ day: 1, age: 0, lat: 72, progress: 0 });

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let newsId = 0;
    const war = new HeroWar(el, {
      caption: (big, small) => setCap((c) => ({ big, small, n: c.n + 1 })),
      news: (text, color) => setNews((list) => [...list.slice(-2), { id: ++newsId, text, color }]),
    }, reduce);
    const publishHud = () => {
      const day = Math.min(HERO_DAYS, Math.floor(war.day) + 1);
      setHud((h) => {
        const next = { day, age: ageOn(war.day), lat: Math.round(war.iceLat()), progress: war.progress };
        return h.day === next.day && h.age === next.age && h.lat === next.lat && Math.abs(h.progress - next.progress) < 0.004 ? h : next;
      });
    };
    const ro = new ResizeObserver(() => {
      war.resize();
      war.draw();
    });
    ro.observe(el);
    if (reduce) {
      war.fastForward(40);
      war.draw();
      publishHud();
      return () => ro.disconnect();
    }
    let raf = 0, last = performance.now(), visible = true;
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      last = performance.now();
    });
    io.observe(el);
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (visible && !document.hidden) {
        war.step(dt);
        war.draw();
        publishHud();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
    };
  }, []);

  return (
    <div className={`relative overflow-hidden ${className}`}>
      <canvas ref={canvas} className="block h-full w-full" role="img" aria-label="A match playing out on the world map: tribes settling, conquering, sailing and bombing while the ice advances from both poles" />
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-md bg-slate-950/70 px-2.5 py-1.5 text-xs text-slate-200 backdrop-blur">
        <span className="display text-sm font-semibold text-white">Day {hud.day}</span>
        <span className="text-amber-200">{AGES[hud.age]} Age</span>
        <span className="hidden text-slate-500 sm:inline">·</span>
        <span className="hidden sm:inline">ice beyond {hud.lat}°</span>
      </div>
      {cap.big && (
        <div key={cap.n} className="hero-cap pointer-events-none absolute left-1/2 top-[9%] z-10 w-[min(92%,760px)] -translate-x-1/2 rounded-full px-4 pb-3 pt-2 text-center">
          <p className="hero-cap-big display text-[clamp(18px,3.4vw,40px)] font-bold leading-tight tracking-wide text-white">{cap.big}</p>
          <p className="mt-1 text-[clamp(11px,1.3vw,15px)] text-slate-200">{cap.small}</p>
        </div>
      )}
      <div className="absolute bottom-4 left-3 z-10 hidden max-w-[60%] gap-1 sm:grid" aria-live="off">
        {news.map((n) => (
          <div key={n.id} className="hero-tick truncate rounded bg-slate-950/70 px-2 py-0.5 text-xs text-slate-200">
            <i className="mr-1.5 inline-block h-2 w-2 rounded-sm align-[-0.5px]" style={{ background: n.color }} />
            {n.text}
          </div>
        ))}
      </div>
      <div className="absolute inset-x-3 bottom-2 z-10 h-1 overflow-hidden rounded bg-slate-800/80">
        <div className="h-full bg-sky-300/80" style={{ width: `${hud.progress * 100}%` }} />
      </div>
    </div>
  );
}
