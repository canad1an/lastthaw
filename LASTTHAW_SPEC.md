# Last Thaw: Game Spec for Claude Code

Domain: lastthaw.com

## How to use this document

This is the design brief for a new browser-based multiplayer strategy game. Please:

1. Read the whole spec first.
2. Propose an architecture, data model and folder structure, and wait for my approval before writing much code.
3. Build in the milestone order at the bottom. Stop at the end of each milestone so I can play-test.
4. Ask me before making any big decision this spec doesn't cover. Numbers marked "starting value" are meant to be tuned, so put them in one config file rather than scattering them through the code.

## The pitch

A real-time browser strategy game set on Earth. Every player starts as five families of hunter-gatherers and grows into an empire over a 30-day match. An ice age creeps in from the poles during the month, shrinking the livable land and forcing players into conflict. Matches have a winner and a hard end date.

Design pillars: build timers and auto-resolved combat with real travel times, fixed-length rounds with a win condition, a real-world map with AI filling empty slots.

## Match structure

- Up to 100 human players per match. AI tribes fill any empty slots.
- A new match starts every week. Each match lasts exactly 30 days, so 4 to 5 matches run at the same time. The server must support many concurrent matches from the start.
- Players join before a match starts. No joining mid-match.
- Everything is real time and keeps running while players are offline.
- A global speed multiplier (1x for real matches, 10x for test matches) scales every timer, production rate and travel time.

## The map

- A real Earth map divided into about 400 regions of roughly equal value (like Risk territories, but more of them). Big real countries simply contain more regions.
- Each region has a terrain type (plains, forest, hills, mountains, desert, coast, etc.) and one or two special resources (for example flint, copper, tin, iron, horses, fertile soil). No region has everything, so trade and conquest matter.
- Regions are connected by land borders and sea routes. Rivers and coasts speed up travel; mountains slow it.
- Players pick a starting region from a balanced list of options. Starting regions must be spread out and roughly equal.
- Fog of war: players only see their own regions, their allies' regions, and regions they've scouted recently.

## The economy

- Base resources: food, wood, stone. Later resources come from special region resources (copper, tin, iron, horses, etc.).
- Population is the key resource. More food grows population. Population is assigned as workers (producing resources), soldiers, or occupiers holding conquered regions.
- Players start with 5 families.
- Each region has storage limits. Resources stored above what's protected can be stolen in raids.

## Ages and tech

Five ages for version 1: Stone, Bronze, Iron, Classical, Medieval.

- Each age has about 5 buildings and about 3 military units.
- Advancing to a new age is a big research project and should be announced to everyone in the match.
- Boats unlock in a mid-game age, targeted to arrive around week 3 for an active player.

## Timers

- Every building, upgrade, research and unit has a build time. Higher levels and later ages take longer.
- Timer curve (starting values): seconds on day 1, minutes by day 3, hours by week 2. The longest single action should be about 8 to 12 hours. Nothing should take days.
- Each player region has a build queue (starting value: 3 slots). Resources are paid when a job is queued.
- Timers must be server-authoritative. Store start and end timestamps and calculate results from them, so nothing depends on a player being online.

## Movement and combat

- Players send armies to a region. Travel time depends on distance, terrain and unit speed.
- Combat resolves automatically when an army arrives. The player doesn't control the battle.
- Every battle produces a battle report for both sides.
- Mission types for version 1: attack/raid, conquer, reinforce an ally, move troops, send resources, scout.
- Raids steal stored resources. Players can protect resources by moving them out before an attack lands.

## Conquest

Taking a region is three steps:

1. Win the battle.
2. Occupy the region by leaving population there. Those people stop working back home.
3. Keep it. Regions far from the capital have a rebellion risk unless the player builds roads, forts or temples there.

This is meant to stop the first big player from snowballing.

## The ice

- Ice advances from both poles on a schedule over the 30 days.
- Frozen regions stop producing. Population there slowly declines or must move.
- By week 4, most players should be squeezed toward the equator.
- Players should be able to see the ice forecast so they can plan.

## Alliances and trade

- Players can form alliances with group chat, shared vision, and the ability to send resources and troops to allies.
- A basic player-to-player market for trading resources.

## Protection

- Beginner protection: new players can't be attacked for the first 3 to 5 days (starting value).
- Optional idea to discuss: a nightly "fortify" option so players aren't wiped out while asleep.

## AI tribes

- AI tribes fill empty slots and also exist as neutral tribes on the map.
- They should be easy targets early on, but they grow, defend themselves and occasionally raid, so the map never feels empty.

## Notifications

- An in-game message center for battle reports, scout reports, completed builds and trade results.
- Incoming attack warnings with a countdown ("warriors arriving in 2h 14m"). This is a core source of tension.
- Real-time updates in the browser (WebSockets or similar). Email or push notifications can come later.

## Winning

- Early win: a player or alliance controls 60% of the regions and holds that for 48 hours. The match ends immediately.
- Otherwise the match ends at day 30 and the highest score wins. Score combines territory held, population and age reached (weights to be tuned).
- A live leaderboard shows score, territory and age for everyone.

## Fair play

- Multi-account detection is required for version 1 (shared IPs, device fingerprints, suspicious resource transfers between accounts). Flag for review rather than auto-ban.
- If paid features are ever added, they must never affect combat or the economy.

## Platform

- Browser-based and mobile-friendly. No native app for version 1.
- Accounts carry over between matches. Keep a history of each player's past matches and finishes.

## Not in version 1

Wonders, religion and culture, deep diplomacy (treaties, embargoes), cosmetics or any paid features, native mobile apps.

## Open questions for later

- Can eliminated players come back (for example as a nomad tribe or vassal), or are they out until the next match?
- Exact score weights.
- How to balance starting regions.

## Suggested milestones

1. **Foundation:** accounts, match creation, the region map with fog of war, and one player growing population and gathering resources with timers.
2. **Building and tech:** build queues, buildings, research and age advancement.
3. **Armies:** units, travel, auto-resolved combat, battle reports, incoming attack warnings, raiding.
4. **Conquest:** occupation, rebellion risk and AI tribes.
5. **Social:** alliances, chat, shared vision, trade market.
6. **Endgame:** the ice, scoring, leaderboard, win conditions and match end.
7. **Launch readiness:** beginner protection, multi-account detection, weekly match scheduler and a 10x test match mode.

After milestone 7, I plan to run a 10x speed test match with 15 to 20 friends (a full match in about 3 days) before a real launch.
