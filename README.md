# Last Thaw

A 30-day browser strategy game on a freezing Earth. Design brief: [LASTTHAW_SPEC.md](LASTTHAW_SPEC.md).
Live at [lastthaw.com](https://lastthaw.com).

## Layout

| Path | What |
|---|---|
| `packages/shared` | Pure game rules, balance config (`src/config/balance.ts`), content tables (`src/config/ages.ts`), map data, shared types. |
| `apps/server` | Fastify API + WebSockets (`src/api`), simulation worker (`src/worker`), game logic (`src/sim`), Drizzle schema and migrations (`src/db`). |
| `apps/web` | React + Vite client. |
| `tools/mapgen` | Natural Earth → `world.json` generator. |
| `deploy` | Caddyfile, deploy scripts and the Lightsail runbook. |

## Run locally

Requires Node 22+ and Docker Desktop.

```bash
npm install
cp .env.example .env
npm run infra:up        # postgres, redis, mailpit
npm run db:migrate
npm run dev             # api on :3000, worker, web on :5173
```

Open http://localhost:5173. Mailpit (local inbox for verification mail) is at http://localhost:8025.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

`npm test` runs the pure-rule unit tests and an end-to-end integration test that drives a whole
10x match through the API against the local Postgres (register → start → build → fight → tick → finish).

## Tuning

Every "starting value" from the spec is in [packages/shared/src/config/balance.ts](packages/shared/src/config/balance.ts):
production rates, growth, storage, timer curve, travel speeds, combat, conquest and loyalty,
ice schedule, AI behaviour, score weights, protection days, weekly schedule. Buildings, units
and techs are in [ages.ts](packages/shared/src/config/ages.ts). Regenerate the map with
`npm run generate --workspace=@lastthaw/mapgen` (preview in `tools/mapgen/out/preview.html`).

## Dev tools

With `DEV_TOOLS=true` (local default; refused in production) verified users can create matches
from the lobby (speed, start delay, how many AI tribes and neutral tribes), start a match early, and
skip the match clock by +1h / +6h / +1d from the match screen. Time skips move only that match's clock.

## Play-testing by milestone

Use two browser profiles (or a private window) for two accounts. Verification links land in Mailpit.

1. **Foundation**: sign up twice, verify, create a 10x match (AI tribes 3, neutral 20), join both, pick capitals from the highlighted options, press *Start now*. Your capital is in your colour, the rest is fogged. Click it: people, food, wood and stone tick live; slide the worker shares; *+1d* jumps a day.
2. **Building and tech**: *Build* tab queues up to 3 jobs per region (paid up front, countdowns, cancel refunds). *Research* panel in the side bar researches one tech at a time, paid from the capital. Fire making → Flint tools → Agriculture → Bronze working advances the age; every player gets a message.
3. **Armies**: *Train* tab turns workers into units. *Army* tab: pick a mission, *Pick target* then click the map, choose units and *Send*. Travel time is previewed. Raid an AI tribe or the other account (after beginner protection, 4 days / speed) and read the battle report in *Messages*; the defender sees a red *Incoming attacks* banner with a countdown. Scouts reveal a region; *Send resources* moves stock out before a raid lands.
4. **Conquest and AI**: *Conquer* with at least 5 people to occupy. Distant conquests drift in loyalty and can rebel (roads, temples, forts help). AI tribes build, research, train and raid weak neighbours; neutral tribes sit on the map with warriors.
5. **Social**: create an alliance, invite the other account, accept. Allied regions appear on your map; *Reinforce* and *Send resources* work between allies; alliance and global chat; the market lets you post "200 wood for 100 stone" and accept others' offers.
6. **Endgame**: toggle *Ice forecast* on the map to see when each region freezes; the ice line creeps toward the equator every day. Frozen regions stop producing and lose people. The leaderboard (link above the map) shows score, regions and age. Holding 60% of regions for 48h ends the match; otherwise day 30 does, and results appear on your profile.
7. **Launch readiness**: beginner protection blocks attacks on new players (attacking forfeits yours). The worker keeps a weekly match lobby open (Mondays 00:00 UTC). Admins (`users.is_admin`) see a fair-play review page at `/admin` listing accounts that share an IP/device or feed each other resources; nothing is banned automatically.

## Deploy

See [deploy/lightsail.md](deploy/lightsail.md). `bash deploy/push.sh` pushes `main` to the dedicated
Lightsail box and redeploys.
