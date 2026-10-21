/**
 * Sound for the game: a handful of effects and a music loop per age, all made on the spot with the Web Audio API, so
 * there is no file to load or license and nothing weighs on players who never turn it on. One AudioContext for the
 * page, opened inside a tap or key press (iPhones only let a context made in a gesture make sound). Effects default
 * on, music off; both and the volume are remembered per device.
 */

export interface AudioSettings {
  effects: boolean;
  music: boolean;
  /** 0..1 */
  volume: number;
}

export type Effect = "build" | "research" | "arrive" | "send" | "battle" | "battle_end" | "message" | "incoming" | "click";

const KEY = "lt_audio";
const DEFAULTS: AudioSettings = { effects: true, music: false, volume: 0.6 };

let settings: AudioSettings = load();
const listeners = new Set<() => void>();

function load(): AudioSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<AudioSettings>;
    return { effects: p.effects ?? DEFAULTS.effects, music: p.music ?? DEFAULTS.music, volume: typeof p.volume === "number" ? Math.min(1, Math.max(0, p.volume)) : DEFAULTS.volume };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getAudioSettings(): AudioSettings {
  return settings;
}

export function setAudioSettings(next: Partial<AudioSettings>): void {
  settings = { ...settings, ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Nothing to do: the choice lasts for this page.
  }
  // Changing a setting is a gesture: the moment to open the context and start or stop the music.
  openAudio();
  applyMusicState();
  for (const l of listeners) l();
}

export function subscribeAudio(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function effectsEnabled(): boolean {
  return settings.effects;
}

// ---------------------------------------------------------------- the context

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let effectsBus: GainNode | null = null;
let musicBus: GainNode | null = null;

export function openAudio(): AudioContext | null {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!ctx) {
      ctx = new Ctx();
      master = ctx.createGain();
      master.gain.value = settings.volume;
      master.connect(ctx.destination);
      effectsBus = ctx.createGain();
      effectsBus.connect(master);
      musicBus = ctx.createGain();
      musicBus.gain.value = 0;
      musicBus.connect(master);
    }
    if (ctx.state === "suspended") void ctx.resume();
    master!.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.05);
    return ctx;
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") {
  const prime = () => {
    openAudio();
    applyMusicState();
  };
  window.addEventListener("pointerdown", prime, { passive: true });
  window.addEventListener("keydown", prime);
  document.addEventListener("visibilitychange", () => applyMusicState());
}

// ---------------------------------------------------------------- effects

function tone(at: number, freq: number, dur: number, type: OscillatorType, peak: number, bus: GainNode, c: AudioContext, glideTo?: number): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(bus);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function noise(at: number, dur: number, peak: number, bus: GainNode, c: AudioContext, cutoff: number): void {
  const frames = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = cutoff;
  const g = c.createGain();
  g.gain.setValueAtTime(peak, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(g).connect(bus);
  src.start(at);
}

/** Play one effect, if effects are on and the page has been touched. Never throws. */
export function play(effect: Effect): void {
  if (!settings.effects) return;
  try {
    const c = openAudio();
    if (!c || !effectsBus) return;
    const at = c.currentTime + 0.01;
    const bus = effectsBus;
    switch (effect) {
      case "build":
        tone(at, 523, 0.12, "triangle", 0.18, bus, c);
        tone(at + 0.12, 784, 0.2, "triangle", 0.18, bus, c);
        break;
      case "research":
        for (const [i, f] of [660, 880, 1320].entries()) tone(at + i * 0.07, f, 0.18, "sine", 0.12, bus, c);
        break;
      case "arrive":
        noise(at, 0.12, 0.25, bus, c, 400);
        tone(at, 110, 0.18, "sine", 0.3, bus, c);
        break;
      case "send":
        noise(at, 0.35, 0.18, bus, c, 1800);
        tone(at, 300, 0.3, "sine", 0.08, bus, c, 900);
        break;
      case "battle":
        for (let i = 0; i < 3; i++) {
          noise(at + i * 0.16, 0.14, 0.4, bus, c, 300);
          tone(at + i * 0.16, 80, 0.16, "square", 0.12, bus, c, 50);
        }
        break;
      case "battle_end":
        tone(at, 392, 0.18, "triangle", 0.16, bus, c);
        tone(at + 0.18, 523, 0.18, "triangle", 0.16, bus, c);
        tone(at + 0.36, 659, 0.35, "triangle", 0.18, bus, c);
        break;
      case "message":
        tone(at, 988, 0.14, "sine", 0.1, bus, c);
        break;
      case "incoming":
        for (const [i, f] of [660, 880].entries()) tone(at + i * 0.14, f, 0.13, "sine", 0.14, bus, c);
        break;
      case "click":
        tone(at, 1400, 0.03, "square", 0.05, bus, c);
        break;
    }
  } catch {
    // No audio: fine.
  }
}

// ---------------------------------------------------------------- music

/** A loop per age: a tempo, a scale, a bass drone and the voice that carries the tune. */
interface Theme {
  bpm: number;
  /** Semitones above the root. */
  scale: number[];
  root: number;
  lead: OscillatorType;
  bass: OscillatorType;
  /** Notes per bar for the lead. */
  density: number;
}

const THEMES: Theme[] = [
  { bpm: 66, scale: [0, 3, 5, 7, 10], root: 110, lead: "sine", bass: "sine", density: 2 }, // Stone: slow pentatonic minor over a drum-like pulse
  { bpm: 80, scale: [0, 2, 4, 7, 9], root: 130.8, lead: "triangle", bass: "sine", density: 3 }, // Bronze: major pentatonic
  { bpm: 92, scale: [0, 2, 3, 5, 7, 8, 10], root: 110, lead: "triangle", bass: "triangle", density: 4 }, // Iron: aeolian
  { bpm: 100, scale: [0, 2, 4, 5, 7, 9, 11], root: 146.8, lead: "sine", bass: "triangle", density: 4 }, // Classical: ionian
  { bpm: 88, scale: [0, 2, 3, 5, 7, 9, 10], root: 123.5, lead: "triangle", bass: "sawtooth", density: 4 }, // Medieval: dorian
  { bpm: 112, scale: [0, 2, 3, 5, 7, 8, 10], root: 98, lead: "sawtooth", bass: "square", density: 6 }, // Industrial: driving aeolian
  { bpm: 120, scale: [0, 2, 4, 6, 7, 9, 11], root: 130.8, lead: "square", bass: "sawtooth", density: 8 }, // Modern: lydian, bright and fast
];

/**
 * Real tracks, when they exist: one file per age under /audio (age-0.mp3 … age-6.mp3). A track that is there plays as a
 * loop in place of the generated one; a missing file falls back to the generated loop, so the game always has music.
 */
const trackBuffers = new Map<number, AudioBuffer | null>();
let trackSource: AudioBufferSourceNode | null = null;
let trackGain: GainNode | null = null;
let trackAge: number | null = null;

async function loadTrack(c: AudioContext, age: number): Promise<AudioBuffer | null> {
  if (trackBuffers.has(age)) return trackBuffers.get(age) ?? null;
  trackBuffers.set(age, null);
  try {
    const res = await fetch(`/audio/age-${age}.mp3`, { cache: "force-cache" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("audio")) return null;
    const buf = await c.decodeAudioData(await res.arrayBuffer());
    trackBuffers.set(age, buf);
    return buf;
  } catch {
    return null;
  }
}

function stopTrack(c: AudioContext): void {
  if (trackSource && trackGain) {
    const src = trackSource;
    trackGain.gain.setTargetAtTime(0, c.currentTime, 0.6);
    setTimeout(() => {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }, 2500);
  }
  trackSource = null;
  trackGain = null;
  trackAge = null;
}

function startTrack(c: AudioContext, bus: GainNode, buf: AudioBuffer, age: number): void {
  stopTrack(c);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.9, c.currentTime + 1.5);
  src.connect(g).connect(bus);
  src.start();
  trackSource = src;
  trackGain = g;
  trackAge = age;
}

let musicAge: number | null = null;
let scheduler: ReturnType<typeof setInterval> | null = null;
let nextBeatAt = 0;
let beat = 0;
let seed = 1;

function rnd(): number {
  // A small deterministic generator, so a loop sounds the same each time an age plays.
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function note(semis: number, root: number): number {
  return root * Math.pow(2, semis / 12);
}

function scheduleBeat(c: AudioContext, bus: GainNode, t: Theme, at: number, b: number): void {
  const barBeat = b % 8;
  // Bass: root on the one, the fifth on the five, soft.
  if (barBeat === 0 || barBeat === 4) tone(at, note(barBeat === 0 ? 0 : 7, t.root / 2), 0.9, t.bass, 0.08, bus, c);
  // A pulse under every beat for the faster ages.
  if (t.bpm >= 100) noise(at, 0.06, 0.05, bus, c, 200);
  // The lead: a walk on the scale, more notes as the ages go on.
  const slots = Math.max(1, Math.round(t.density / 2));
  const step = (60 / t.bpm) / slots;
  for (let s = 0; s < slots; s++) {
    if (rnd() < 0.3) continue;
    const degree = Math.floor(rnd() * t.scale.length);
    const octave = rnd() < 0.25 ? 2 : 1;
    tone(at + s * step, note(t.scale[degree]! + 12 * octave, t.root), step * 0.9, t.lead, 0.045, bus, c);
  }
}

function tick(): void {
  if (!ctx || !musicBus || musicAge === null) return;
  const t = THEMES[Math.min(THEMES.length - 1, Math.max(0, musicAge))]!;
  const beatLen = 60 / t.bpm;
  const horizon = ctx.currentTime + 0.6;
  if (nextBeatAt < ctx.currentTime - 1) nextBeatAt = ctx.currentTime + 0.05;
  while (nextBeatAt < horizon) {
    scheduleBeat(ctx, musicBus, t, nextBeatAt, beat);
    nextBeatAt += beatLen;
    beat += 1;
  }
}

function stopGenerated(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
}

function applyMusicState(): void {
  const wants = settings.music && musicAge !== null && document.visibilityState === "visible";
  if (wants) {
    const c = openAudio();
    if (!c || !musicBus) return;
    const bus = musicBus;
    const age = musicAge;
    if (age === null) return;
    musicBus.gain.cancelScheduledValues(c.currentTime);
    musicBus.gain.setTargetAtTime(0.9, c.currentTime, 0.8);
    // A real track for this age plays as a loop; until it is known (or when there is none) the generated loop plays.
    void loadTrack(c, age).then((buf) => {
      if (musicAge !== age || !settings.music) return;
      if (buf) {
        stopGenerated();
        if (trackAge !== age) startTrack(c, bus, buf, age);
      } else if (!scheduler) {
        stopTrack(c);
        nextBeatAt = c.currentTime + 0.05;
        scheduler = setInterval(tick, 200);
        tick();
      }
    });
  } else {
    if (ctx && musicBus) {
      musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
      stopTrack(ctx);
    }
    stopGenerated();
  }
}

/** The age whose loop should play, or null to stop (leaving the match). Switching ages crossfades into the new loop. */
export function setMusicAge(age: number | null): void {
  if (age === musicAge) return;
  musicAge = age;
  seed = 7 + (age ?? 0) * 101;
  beat = 0;
  if (ctx) {
    nextBeatAt = ctx.currentTime + 0.3;
    if (age === null || trackAge !== null) stopTrack(ctx);
  }
  stopGenerated();
  applyMusicState();
}
