/**
 * Each age has a look: an emblem and an accent colour that the match bars, cards and badges pick up,
 * so moving from the Stone Age into Bronze is something you see, not only a number that changed.
 */
export interface AgeTheme {
  name: string;
  emblem: string;
  /** Solid accent (borders, the top stripe, the age badge). */
  accent: string;
  /** The same colour, faint, for backgrounds. */
  soft: string;
  /** For text on dark panels. */
  text: string;
}

const THEMES: AgeTheme[] = [
  { name: "Stone", emblem: "🪨", accent: "#a8a29e", soft: "rgba(168, 162, 158, 0.14)", text: "#e7e5e4" },
  { name: "Bronze", emblem: "🏺", accent: "#d97706", soft: "rgba(217, 119, 6, 0.16)", text: "#fcd34d" },
  { name: "Iron", emblem: "⚒", accent: "#94a3b8", soft: "rgba(148, 163, 184, 0.16)", text: "#e2e8f0" },
  { name: "Classical", emblem: "🏛", accent: "#eab308", soft: "rgba(234, 179, 8, 0.14)", text: "#fef3c7" },
  { name: "Medieval", emblem: "🏰", accent: "#dc2626", soft: "rgba(220, 38, 38, 0.16)", text: "#fecaca" },
  { name: "Industrial", emblem: "⚙", accent: "#b45309", soft: "rgba(180, 83, 9, 0.16)", text: "#fde68a" },
  { name: "Modern", emblem: "🛰", accent: "#e2e8f0", soft: "rgba(226, 232, 240, 0.12)", text: "#f8fafc" },
];

export function ageTheme(age: number): AgeTheme {
  return THEMES[Math.max(0, Math.min(THEMES.length - 1, Math.floor(age)))] ?? THEMES[0]!;
}

/** CSS variables for the match screen's root, read by the bars, cards and the sheet handle. */
export function ageVars(age: number): Record<string, string> {
  const t = ageTheme(age);
  return { "--age-accent": t.accent, "--age-soft": t.soft, "--age-text": t.text };
}
