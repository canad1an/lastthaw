# Last Thaw

A 30-day browser strategy game on a freezing Earth. Design brief: [LASTTHAW_SPEC.md](LASTTHAW_SPEC.md).
Live at [lastthaw.com](https://lastthaw.com) once launched.

## Layout

| Path | What |
|---|---|
| `packages/shared` | Pure game rules, balance config (`src/config/balance.ts`), map data, shared types. No runtime deps beyond zod. |
| `apps/server` | Fastify API + WebSockets (`src/api`), simulation worker (`src/worker`), Drizzle schema and migrations (`src/db`). |
| `apps/web` | React + Vite client. |
| `tools/mapgen` | One-time Natural Earth → `world.json` generator (milestone 1). |
| `deploy` | Caddyfile and the Lightsail runbook. |

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

## Milestones and play-tests

Each milestone ends with a play-test before the next begins.

- [x] **M0 Skeleton**: `npm run dev` shows the Last Thaw page with API status, server time and a live WebSocket tick.
- [x] **M1 Foundation**: accounts, match lobby, world map with fog of war, first region growing.

  Play-test (two browser profiles or one normal + one private window):
  1. Sign up twice. Open http://localhost:8025 (Mailpit), click each verification link.
  2. In the lobby, create a match (dev tool): speed 10, starts in 5 minutes. Join with both accounts.
  3. Open the match: pick a capital from the highlighted options with each account. Options are at least 900 km apart.
  4. Press "Start now" (dev tool) or wait for the start time. The map now shows your capital in your colour; everything else is fogged.
  5. Click your capital: people, food, wood and stone tick up live. Drag the worker sliders and Apply; rates change.
  6. Press "+1d" (dev time-skip): population and stock jump as if a day passed. Set food to 0% and skip a day: starvation warning and shrinking population.
  7. The other account never sees your region's numbers. Both tabs update live when the match starts (WebSocket).

  Regenerate the world map (only needed when the map rules change): `npm run generate --workspace=@lastthaw/mapgen`, then open `tools/mapgen/out/preview.html`.

- [ ] **M2 Building and tech**
- [ ] **M3 Armies**
- [ ] **M4 Conquest and AI**
- [ ] **M5 Social**
- [ ] **M6 Endgame**
- [ ] **M7 Launch readiness**

## Deploy

See [deploy/lightsail.md](deploy/lightsail.md). Last Thaw runs on its own Lightsail instance.
