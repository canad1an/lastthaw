import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
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
    seed: text("seed").notNull(),
    lobbyOpensAt: timestamp("lobby_opens_at", { withTimezone: true }).notNull().defaultNow(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    winnerPlayerId: uuid("winner_player_id"),
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
    /** Match-clock time the amounts above were last settled to. */
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.regionId] }), index("match_regions_owner_idx").on(t.matchId, t.ownerPlayerId)],
);

/** Partial index predicate for the due-job scan. */
const sqlNullCompleted = sql`completed_at is null and cancelled_at is null`;

export const jobKind = pgEnum("job_kind", ["build", "research", "train", "mission", "ice_step", "win_hold", "match_end"]);

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
