import { sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, real } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Accounts: carry over between matches. Never hold match state.
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    isAdmin: boolean("is_admin").notNull().default(false),
    /** Private beta: only approved accounts may join matches. Set by an admin. */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Set by an admin: the account cannot log in and its sessions are gone until cleared. */
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendReason: text("suspend_reason"),
    /** Profile details the player writes about themselves; all optional. */
    tagline: text("tagline"),
    bio: text("bio"),
    location: text("location"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email), uniqueIndex("users_name_idx").on(sql`lower(${t.displayName})`)],
);

/** Multi-account review queue. Flags are for a human to look at, never auto-bans. */
export const fairplayFlags = pgTable(
  "fairplay_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userA: uuid("user_a").notNull(),
    userB: uuid("user_b").notNull(),
    matchId: uuid("match_id"),
    reason: text("reason").notNull(),
    /** Higher is more suspicious. */
    score: integer("score").notNull().default(1),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    verdict: text("verdict"),
  },
  (t) => [uniqueIndex("fairplay_pair_idx").on(t.userA, t.userB, t.matchId, t.reason), index("fairplay_open_idx").on(t.reviewedAt)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** sha256 of the cookie token; the token itself is never stored. */
    tokenHash: text("token_hash"),
    /** Last request on this session, kept to a 10-minute grain; idle sessions expire. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** Client-supplied device fingerprint hash, if any. */
    fingerprint: text("fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_ip_idx").on(t.ip), uniqueIndex("sessions_token_idx").on(t.tokenHash)],
);

/** Match history per account: the spec's "keep a history of each player's past matches and finishes". */
export const userMatchResults = pgTable(
  "user_match_results",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    matchId: uuid("match_id").notNull(),
    playerId: uuid("player_id").notNull(),
    finalRank: integer("final_rank").notNull(),
    score: integer("score").notNull(),
    regionsHeld: integer("regions_held").notNull(),
    ageReached: integer("age_reached").notNull(),
    eliminatedAt: timestamp("eliminated_at", { withTimezone: true }),
    won: boolean("won").notNull().default(false),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.matchId] })],
);

export const emailTokenKind = pgEnum("email_token_kind", ["verify", "reset"]);

export const emailTokens = pgTable(
  "email_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: emailTokenKind("kind").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("email_tokens_hash_idx").on(t.tokenHash)],
);

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export const matchStatus = pgEnum("match_status", ["lobby", "running", "finished"]);

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status: matchStatus("status").notNull().default("lobby"),
    /** Speed multiplier. Immutable after the match starts. */
    speed: integer("speed").notNull().default(1),
    /** Dev-only time skip, in seconds, added to the database clock for this match. */
    clockOffsetSeconds: integer("clock_offset_seconds").notNull().default(0),
    workerLease: text("worker_lease"),
    workerLeaseUntil: timestamp("worker_lease_until", { withTimezone: true }),
    /** Match-clock time of the last periodic tick (loyalty, AI, score, win check). */
    lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
    /** Set while the match is paused: the clock stands still, nothing completes, moves or acts; resuming shifts every timestamp forward. */
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    seed: text("seed").notNull(),
    lobbyOpensAt: timestamp("lobby_opens_at", { withTimezone: true }).notNull().defaultNow(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    winnerPlayerId: uuid("winner_player_id"),
    /** How it ended: hold (60% for 48h), wonder, survival (most people on day 30), score. */
    winKind: text("win_kind"),
    settings: jsonb("settings").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("matches_status_idx").on(t.status)],
);

export const players = pgTable(
  "players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    isAi: boolean("is_ai").notNull().default(false),
    aiProfile: text("ai_profile"),
    /** System players (the horde) that never appear in lists or standings. */
    hidden: boolean("hidden").notNull().default(false),
    name: text("name").notNull(),
    capitalRegionId: text("capital_region_id"),
    age: integer("age").notNull().default(0),
    score: integer("score").notNull().default(0),
    protectionUntil: timestamp("protection_until", { withTimezone: true }),
    eliminatedAt: timestamp("eliminated_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    nextAiAt: timestamp("next_ai_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("players_match_idx").on(t.matchId), uniqueIndex("players_match_user_idx").on(t.matchId, t.userId)],
);

// ---------------------------------------------------------------------------
// Territory and economy. A row exists only for regions somebody owns or that
// hold population; every other region is implicitly neutral and empty.
// ---------------------------------------------------------------------------

export const matchRegions = pgTable(
  "match_regions",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    regionId: text("region_id").notNull(),
    ownerPlayerId: uuid("owner_player_id").references(() => players.id, { onDelete: "set null" }),
    popWorkers: doublePrecision("pop_workers").notNull().default(0),
    popSoldiers: doublePrecision("pop_soldiers").notNull().default(0),
    popOccupiers: doublePrecision("pop_occupiers").notNull().default(0),
    food: doublePrecision("food").notNull().default(0),
    wood: doublePrecision("wood").notNull().default(0),
    stone: doublePrecision("stone").notNull().default(0),
    /** Metals and horses: { copper, tin, iron, horses }. */
    special: jsonb("special").$type<Record<string, number>>().notNull().default({}),
    /** Worker shares per gathering job: { food, wood, stone } summing to 1. */
    assignment: jsonb("assignment").$type<{ food: number; wood: number; stone: number }>().notNull(),
    storageLevel: integer("storage_level").notNull().default(0),
    buildings: jsonb("buildings").$type<Record<string, number>>().notNull().default({}),
    /** Stationed units by unit id. Sum equals popSoldiers. */
    units: jsonb("units").$type<Record<string, number>>().notNull().default({}),
    loyalty: doublePrecision("loyalty").notNull().default(1),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    /** Production multiplier from the ice taper (1 = untouched). Updated by the daily ice step. */
    iceFactor: doublePrecision("ice_factor").notNull().default(1),
    /** True for the owner's capital: bigger storage, destination of overflow caravans. Kept in step with players.capitalRegionId. */
    isCapital: boolean("is_capital").notNull().default(false),
    /** Taken by force from someone else: needs occupiers to stay loyal. Settled and founded regions are your own people. */
    conquered: boolean("conquered").notNull().default(false),
    /** A blizzard is blowing here until then: half production, double travel. */
    stormUntil: timestamp("storm_until", { withTimezone: true }),
    /** Sickness until then: no growth, people die. */
    plagueUntil: timestamp("plague_until", { withTimezone: true }),
    /** A thaw pocket: the ice passes this region by until then. */
    thawUntil: timestamp("thaw_until", { withTimezone: true }),
    /** A rich find: `resource` output doubled until `until` (ISO). */
    boom: jsonb("boom").$type<{ resource: string; until: string } | null>(),
    /** Emptied by an evacuation: no growth or production until people move back in. */
    evacuatedAt: timestamp("evacuated_at", { withTimezone: true }),
    /** Match-clock time the amounts above were last settled to. */
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.regionId] }), index("match_regions_owner_idx").on(t.matchId, t.ownerPlayerId)],
);

/** Partial index predicate for the due-job scan. */
const sqlNullCompleted = sql`completed_at is null and cancelled_at is null`;

export const jobKind = pgEnum("job_kind", ["build", "research", "train", "mission", "ice_step", "win_hold", "match_end", "storm", "merc_expire"]);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "cascade" }),
    regionId: text("region_id"),
    kind: jobKind("kind").notNull(),
    /** Build jobs only: materials still to arrive by caravan before the build can start. Null once started. */
    waitingFor: jsonb("waiting_for").$type<Record<string, number>>(),
    refId: text("ref_id"),
    level: integer("level"),
    qty: integer("qty"),
    slot: integer("slot"),
    payload: jsonb("payload").notNull().default({}),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_due_idx").on(t.endsAt).where(sqlNullCompleted),
    index("jobs_region_idx").on(t.matchId, t.regionId),
  ],
);

export const missionKind = pgEnum("mission_kind", ["raid", "conquer", "reinforce", "move", "transport", "scout", "settle", "relocate", "patrol"]);
export const armyStatus = pgEnum("army_status", ["outbound", "returning", "done"]);

export const armies = pgTable(
  "armies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    mission: missionKind("mission").notNull(),
    /** Why the army turned back, shown next to it while returning (null when all went to plan). */
    note: text("note"),
    /** Sea lane held by a patrol ("a|b", region ids sorted). */
    lane: text("lane"),
    originRegionId: text("origin_region_id").notNull(),
    targetRegionId: text("target_region_id").notNull(),
    units: jsonb("units").$type<Record<string, number>>().notNull().default({}),
    /** Carried resources and people: { food, wood, stone, copper, tin, iron, horses, people }. */
    cargo: jsonb("cargo").$type<Record<string, number>>().notNull().default({}),
    path: jsonb("path").$type<string[]>().notNull().default([]),
    status: armyStatus("status").notNull().default("outbound"),
    departsAt: timestamp("departs_at", { withTimezone: true }).notNull(),
    arrivesAt: timestamp("arrives_at", { withTimezone: true }).notNull(),
    returnsAt: timestamp("returns_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("armies_match_status_idx").on(t.matchId, t.status), index("armies_target_idx").on(t.matchId, t.targetRegionId)],
);

export const battles = pgTable(
  "battles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    regionId: text("region_id").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull(),
    seed: text("seed").notNull(),
    attackerPlayerId: uuid("attacker_player_id"),
    defenderPlayerId: uuid("defender_player_id"),
    report: jsonb("report").notNull(),
  },
  (t) => [index("battles_match_idx").on(t.matchId, t.resolvedAt)],
);

export const tradeRouteMode = pgEnum("trade_route_mode", ["fixed", "share"]);

/** Automated caravan routes: the worker dispatches transport missions on a schedule. */
export const tradeRoutes = pgTable(
  "trade_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    fromRegionId: text("from_region_id").notNull(),
    toRegionId: text("to_region_id").notNull(),
    mode: tradeRouteMode("mode").notNull().default("fixed"),
    /** Fixed mode: goods per trip. */
    load: jsonb("load").$type<Record<string, number>>().notNull().default({}),
    /** Share mode: fraction of gross production per interval. */
    share: doublePrecision("share").notNull().default(0),
    caravans: integer("caravans").notNull().default(1),
    everyHours: doublePrecision("every_hours").notNull().default(2),
    enabled: boolean("enabled").notNull().default(true),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastResult: text("last_result"),
    /** Stock-up routes: total goods to deliver, after which the route removes itself. */
    target: jsonb("target").$type<Record<string, number>>(),
    /** Set when the route carries materials for a waiting build job; removed with the job. */
    forJobId: uuid("for_job_id"),
    delivered: jsonb("delivered").$type<Record<string, number>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trade_routes_due_idx").on(t.nextAt), index("trade_routes_from_idx").on(t.matchId, t.fromRegionId)],
);

/** Score, regions and people per player, sampled every quarter of a match day by the tick: the growth chart at the end. */
export const scoreHistory = pgTable(
  "score_history",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    day: real("day").notNull(),
    score: integer("score").notNull(),
    regions: integer("regions").notNull(),
    population: integer("population").notNull(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.playerId, t.day] })],
);

/**
 * Replay frames: who held which region, sampled every quarter of a match day.
 * Each frame stores only what changed since the previous one (region → player id,
 * "ice" once frozen, null when abandoned); the first frame is complete.
 */
export const ownershipFrames = pgTable(
  "ownership_frames",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    day: real("day").notNull(),
    changes: jsonb("changes").$type<Record<string, string | null>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.day] })],
);

/** The owner map as of the latest frame, so the next diff is cheap. */
export const ownershipLatest = pgTable("ownership_latest", {
  matchId: uuid("match_id")
    .primaryKey()
    .references(() => matches.id, { onDelete: "cascade" }),
  owners: jsonb("owners").$type<Record<string, string>>().notNull(),
});

/** Where a session was seen, one row per session per hour: the fair-play scan compares addresses across accounts. */
export const sessionSightings = pgTable(
  "session_sightings",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    ip: text("ip").notNull(),
    userAgent: text("user_agent"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.hour] }), index("sightings_ip_idx").on(t.ip, t.userId)],
);

/** A migrant column at the border: the owner of `regionId` may take them in before `expiresAt`. */
export const refugeeOffers = pgTable(
  "refugee_offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    regionId: text("region_id").notNull(),
    fromRegionId: text("from_region_id").notNull(),
    people: integer("people").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    accepted: boolean("accepted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("refugees_player_idx").on(t.playerId, t.decidedAt)],
);

/** First-in-the-match checkpoints: one row per key, held by whoever got there first. */
export const matchMilestones = pgTable(
  "match_milestones",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.key] })],
);

export const playerTechs = pgTable(
  "player_techs",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    techId: text("tech_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.playerId, t.techId] })],
);

// ---------------------------------------------------------------------------
// Social: alliances, chat, market
// ---------------------------------------------------------------------------

export const alliances = pgTable(
  "alliances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tag: text("tag").notNull(),
    leaderPlayerId: uuid("leader_player_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("alliances_match_tag_idx").on(t.matchId, t.tag)],
);

export const allianceMembers = pgTable(
  "alliance_members",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    allianceId: uuid("alliance_id")
      .notNull()
      .references(() => alliances.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.playerId] }), index("alliance_members_alliance_idx").on(t.allianceId)],
);

export const allianceInvites = pgTable(
  "alliance_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    allianceId: uuid("alliance_id")
      .notNull()
      .references(() => alliances.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("alliance_invites_unique_idx").on(t.allianceId, t.playerId)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    /** "global" or "alliance:<id>". */
    channel: text("channel").notNull(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    playerName: text("player_name").notNull(),
    body: text("body").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_channel_idx").on(t.matchId, t.channel, t.sentAt)],
);

export const marketOrders = pgTable(
  "market_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    regionId: text("region_id").notNull(),
    /** What the seller gives and what they want in return. */
    offerResource: text("offer_resource").notNull(),
    offerAmount: doublePrecision("offer_amount").notNull(),
    askResource: text("ask_resource").notNull(),
    askAmount: doublePrecision("ask_amount").notNull(),
    status: text("status").notNull().default("open"),
    filledByPlayerId: uuid("filled_by_player_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    filledAt: timestamp("filled_at", { withTimezone: true }),
  },
  (t) => [index("market_orders_match_idx").on(t.matchId, t.status)],
);

export const transfers = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    fromPlayerId: uuid("from_player_id"),
    toPlayerId: uuid("to_player_id"),
    resource: text("resource").notNull(),
    amount: doublePrecision("amount").notNull(),
    via: text("via").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("transfers_match_idx").on(t.matchId, t.at)],
);

// ---------------------------------------------------------------------------
// Fog of war, messaging and audit
// ---------------------------------------------------------------------------

export const regionSightings = pgTable(
  "region_sightings",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    regionId: text("region_id").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
    snapshot: jsonb("snapshot").notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.playerId, t.regionId] })],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    payload: jsonb("payload").notNull().default({}),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_player_idx").on(t.playerId, t.readAt)],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
  },
  (t) => [index("events_match_idx").on(t.matchId, t.at)],
);
