import { AGES, TECHS, techById } from "../config/ages.js";
import { balance } from "../config/balance.js";

/**
 * What opens on a given match day (1-based, as the top bar shows it), for the morning brief. Day values in the config
 * count whole days gone, so a tech with earliestDay 4 and an event from day 3 first open on days 5 and 4.
 */
export function newOnDay(day: number): string[] {
  const out: string[] = [];
  const opens = (v: number) => v + 1 === day;
  for (const t of TECHS) {
    if (t.advancesTo === undefined || t.earliestDay === undefined || !opens(t.earliestDay)) continue;
    const needs = (t.requires ?? []).map((id) => techById.get(id)?.name ?? id);
    out.push(`The ${AGES[t.advancesTo]} Age opens: ${t.name} can be researched from today${needs.length ? ` (it needs ${needs.join(" and ")})` : ""}.`);
  }
  if (opens(balance.match.protectionDays)) out.push("Beginner protection is over: every tribe can be attacked now, and can attack.");
  const ev = balance.events;
  if (opens(ev.storm.fromDay)) out.push(`Blizzards can strike from today. Each comes with a ${ev.storm.warningHours}-hour warning and halves production and slows travel where it lands.`);
  if (opens(ev.thaw.fromDay)) out.push("Thaw pockets: now and then a valuable region near the ice line stays open a few days longer.");
  if (opens(ev.horde.fromDay)) out.push(`${ev.horde.name} can ride out of the ice from today, against the richest region in reach.`);
  if (opens(ev.horde.catapultsFromDay)) out.push(`${ev.horde.name} brings catapults from today: a wall alone will not hold it.`);
  if (opens(ev.horde.lateDay)) out.push(`${ev.horde.name} rides out more often from today.`);
  if (opens(balance.match.alliancesEndDay - 1)) out.push("Last day of alliances: every alliance dissolves when this day ends, and none can be formed after. Settle what you owe your allies today.");
  if (opens(balance.match.alliancesEndDay)) out.push("Every alliance has dissolved: from today each tribe stands alone, and no new alliance can be formed.");
  if (day === balance.match.lengthDays) out.push("The last day. When it ends the ice stops, and the tribe with the most people alive in unfrozen land wins.");
  return out;
}
