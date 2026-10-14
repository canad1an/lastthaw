import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
