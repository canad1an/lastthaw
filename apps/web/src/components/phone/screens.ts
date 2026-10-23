import type { MenuId } from "../TopMenu.js";
import type { RegionTab } from "../RegionPanel.js";

/** Everything a phone can show as its own screen: the menu's panels plus what the desktop keeps in its side column. */
export type PanelId = MenuId | "research" | "routes" | "activity" | "warnings";

/**
 * One screen at a time over the map, kept as a stack so Back always goes where you came from:
 * map → region, map → menu → a panel, map → a tab's panel.
 */
export type Screen = { kind: "map" } | { kind: "region"; id: string; tab: RegionTab } | { kind: "menu" } | { kind: "panel"; id: PanelId };

export const PANEL_TITLES: Record<PanelId, string> = {
  messages: "Messages",
  battles: "Battles",
  alliance: "Alliance",
  chat: "Chat",
  market: "Market",
  players: "Players",
  leaderboard: "Leaderboard",
  view: "Map overlays",
  sound: "Sound",
  game: "Game",
  empire: "Resources",
  logistics: "Logistics",
  advisors: "Advisors",
  tech: "Tech tree",
  research: "Research",
  routes: "Trade routes",
  activity: "Activity",
  warnings: "Alerts",
};

export type PhoneTab = "map" | "region" | "empire" | "research" | "more";

/** Which bottom tab a screen belongs to, so the bar highlights where you are. */
export function tabOf(screen: Screen): PhoneTab {
  if (screen.kind === "map") return "map";
  if (screen.kind === "region") return "region";
  if (screen.kind === "menu") return "more";
  if (screen.id === "empire") return "empire";
  if (screen.id === "research") return "research";
  return "more";
}
