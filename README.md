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
- [ ] **M1 Foundation**: accounts, match lobby, world map with fog of war, first region growing.
- [ ] **M2 Building and tech**
- [ ] **M3 Armies**
- [ ] **M4 Conquest and AI**
- [ ] **M5 Social**
- [ ] **M6 Endgame**
- [ ] **M7 Launch readiness**

## Deploy

See [deploy/lightsail.md](deploy/lightsail.md). Last Thaw runs on its own Lightsail instance.
