import { z } from "zod";

/** Every API response carries the server time so clients can compute countdowns from an offset. */
export const healthResponse = z.object({
  ok: z.literal(true),
  serverTime: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponse>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const registerBody = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(2).max(24),
});
export const loginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
export const verifyBody = z.object({ token: z.string().min(10) });
export const forgotBody = z.object({ email: z.string().email() });
export const resetBody = z.object({ token: z.string().min(10), password: z.string().min(8).max(200) });

export const userView = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
});
export type UserView = z.infer<typeof userView>;

// ---------------------------------------------------------------------------
// Matches and lobby
// ---------------------------------------------------------------------------

export const matchStatus = z.enum(["lobby", "running", "finished"]);
export type MatchStatus = z.infer<typeof matchStatus>;

export const matchSummary = z.object({
  id: z.string(),
  name: z.string(),
  status: matchStatus,
  speed: z.number(),
  startsAt: z.string(),
  endsAt: z.string(),
  humanPlayers: z.number(),
  maxPlayers: z.number(),
  joined: z.boolean(),
  /** My player id in this match, if joined. */
  playerId: z.string().nullable(),
  capitalRegionId: z.string().nullable(),
});
export type MatchSummary = z.infer<typeof matchSummary>;

export const createMatchBody = z.object({
  name: z.string().trim().min(2).max(40),
  speed: z.number().int().min(1).max(100),
  startsInMinutes: z.number().int().min(0).max(60 * 24 * 14),
});

export const pickStartBody = z.object({ regionId: z.string() });
export const assignBody = z.object({
  food: z.number().min(0).max(1),
  wood: z.number().min(0).max(1),
  stone: z.number().min(0).max(1),
});
export const timeSkipBody = z.object({ seconds: z.number().int().min(1).max(60 * 60 * 24 * 40) });

// ---------------------------------------------------------------------------
// Match state as seen by one player (fog of war applied server-side)
// ---------------------------------------------------------------------------

export const assignment = z.object({ food: z.number(), wood: z.number(), stone: z.number() });
export const specialStock = z.object({ copper: z.number(), tin: z.number(), iron: z.number(), horses: z.number() });

export const ownedRegionView = z.object({
  regionId: z.string(),
  ownerPlayerId: z.string(),
  popWorkers: z.number(),
  popSoldiers: z.number(),
  popOccupiers: z.number(),
  food: z.number(),
  wood: z.number(),
  stone: z.number(),
  special: specialStock,
  assignment,
  storage: z.object({ food: z.number(), wood: z.number(), stone: z.number() }),
  capacity: z.number(),
  yieldMult: z.object({ food: z.number(), wood: z.number(), stone: z.number() }),
  extract: z.record(z.string(), z.number()),
  buildings: z.record(z.string(), z.number()),
  units: z.record(z.string(), z.number()),
  effects: z.object({
    defense: z.number(),
    loyalty: z.number(),
    researchSpeed: z.number(),
    trainSpeed: z.number(),
    protect: z.number(),
    harbor: z.boolean(),
    roads: z.number(),
  }),
  loyalty: z.number(),
  frozen: z.boolean(),
  /** Server time the amounts above are valid for. Clients project forward from here. */
  asOf: z.string(),
  rates: z.object({ food: z.number(), wood: z.number(), stone: z.number(), population: z.number(), starving: z.boolean() }),
  isCapital: z.boolean(),
});
export type OwnedRegionView = z.infer<typeof ownedRegionView>;

export const jobView = z.object({
  id: z.string(),
  kind: z.enum(["build", "research", "train", "mission", "ice_step", "win_hold", "match_end"]),
  regionId: z.string().nullable(),
  refId: z.string().nullable(),
  level: z.number().nullable(),
  qty: z.number().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
});
export type JobView = z.infer<typeof jobView>;

export const missionKind = z.enum(["raid", "conquer", "reinforce", "move", "transport", "scout"]);
export type MissionKind = z.infer<typeof missionKind>;

export const sendArmyBody = z.object({
  mission: missionKind,
  targetRegionId: z.string(),
  units: z.record(z.string(), z.number().int().min(0)),
  /** People to carry as occupiers (conquer) or settlers (move/reinforce). */
  people: z.number().int().min(0).default(0),
  cargo: z.record(z.string(), z.number().min(0)).default({}),
});

export const armyView = z.object({
  id: z.string(),
  playerId: z.string(),
  mission: missionKind,
  originRegionId: z.string(),
  targetRegionId: z.string(),
  units: z.record(z.string(), z.number()),
  cargo: z.record(z.string(), z.number()),
  status: z.enum(["outbound", "returning", "done"]),
  departsAt: z.string(),
  arrivesAt: z.string(),
  returnsAt: z.string().nullable(),
});
export type ArmyView = z.infer<typeof armyView>;

/** What a defender is told about an army heading their way. */
export const incomingView = z.object({
  id: z.string(),
  mission: missionKind,
  targetRegionId: z.string(),
  fromPlayerId: z.string(),
  fromPlayerName: z.string(),
  arrivesAt: z.string(),
  /** Rough size only; the exact composition stays hidden. */
  size: z.number(),
});
export type IncomingView = z.infer<typeof incomingView>;

export const routePreview = z.object({
  path: z.array(z.string()),
  seconds: z.number(),
  usesSea: z.boolean(),
});

export const buildBody = z.object({ buildingId: z.string() });
export const trainBody = z.object({ unitId: z.string(), qty: z.number().int().min(1).max(1000) });
export const researchBody = z.object({ techId: z.string() });

/** What a player knows about a region they do not own. */
export const sightedRegionView = z.object({
  regionId: z.string(),
  ownerPlayerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  population: z.number().nullable(),
  seenAt: z.string(),
});
export type SightedRegionView = z.infer<typeof sightedRegionView>;

export const playerPublic = z.object({
  id: z.string(),
  name: z.string(),
  isAi: z.boolean(),
  age: z.number(),
  score: z.number(),
  regions: z.number(),
});

export const matchStateView = z.object({
  match: z.object({
    id: z.string(),
    name: z.string(),
    status: matchStatus,
    speed: z.number(),
    startsAt: z.string(),
    endsAt: z.string(),
    /** Match clock (server time plus any dev time skip), ISO. */
    now: z.string(),
    clockOffsetSeconds: z.number(),
  }),
  me: z.object({
    playerId: z.string(),
    name: z.string(),
    capitalRegionId: z.string().nullable(),
    protectionUntil: z.string().nullable(),
    age: z.number(),
    techs: z.array(z.string()),
  }),
  owned: z.array(ownedRegionView),
  sighted: z.array(sightedRegionView),
  players: z.array(playerPublic),
  /** Pending build/train jobs in my regions plus my research job, if any. */
  jobs: z.array(jobView),
  /** My armies in flight. */
  armies: z.array(armyView),
  /** Hostile armies heading for my regions. */
  incoming: z.array(incomingView),
});
export type MatchStateView = z.infer<typeof matchStateView>;

export const startOption = z.object({
  regionId: z.string(),
  taken: z.boolean(),
});

// ---------------------------------------------------------------------------
// Realtime events (WebSocket). Payloads are hints; clients refetch state.
// ---------------------------------------------------------------------------

export const wsClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), matchId: z.string() }),
  z.object({ type: z.literal("unsubscribe"), matchId: z.string() }),
  z.object({ type: z.literal("ping") }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessage>;

export const wsServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), serverTime: z.string() }),
  z.object({ type: z.literal("pong"), serverTime: z.string() }),
  z.object({ type: z.literal("subscribed"), matchId: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({
    type: z.literal("event"),
    matchId: z.string(),
    kind: z.string(),
    at: z.string(),
    payload: z.unknown(),
  }),
]);
export type WsServerMessage = z.infer<typeof wsServerMessage>;

/** Event kinds published on match and player channels. */
export const EVENT_KINDS = [
  "match.started",
  "match.finished",
  "region.updated",
  "player.joined",
  "time.skipped",
  "job.completed",
  "age.advanced",
  "message.new",
  "army.sent",
  "army.incoming",
  "army.arrived",
  "region.conquered",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
