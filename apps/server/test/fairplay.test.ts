import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { fairplayFlags, matches, players, sessions, transfers, users } from "../src/db/schema.js";
import { detectMultiAccounts } from "../src/fairplay/detect.js";
import { hashPassword } from "../src/auth/password.js";
import { nameSuffix } from "./suffix.js";

process.env.DATABASE_URL ??= "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";

describe("multi-account detection", () => {
  let db: Db;
  const suffix = nameSuffix();
  const emails = [`fp-a-${suffix}@example.test`, `fp-b-${suffix}@example.test`, `fp-c-${suffix}@example.test`];
  let matchId: string;
  let userIds: string[] = [];

  beforeAll(async () => {
    db = createDb();
    const hash = await hashPassword("irrelevant-password");
    const inserted = await db
      .insert(users)
      .values(emails.map((email, i) => ({ email, displayName: `FP${i}${suffix}`, passwordHash: hash, emailVerifiedAt: new Date() })))
      .returning({ id: users.id });
    userIds = inserted.map((u) => u.id);
    const [m] = await db
      .insert(matches)
      .values({ name: `fp-${suffix}`, status: "running", speed: 10, seed: "s", startsAt: new Date(), endsAt: new Date(Date.now() + 86400_000) })
      .returning({ id: matches.id });
    matchId = m!.id;
    const ps = await db
      .insert(players)
      .values(userIds.map((userId, i) => ({ matchId, userId, name: `P${i}` })))
      .returning({ id: players.id, userId: players.userId });
    // A and B share a home IP and a device; C is unrelated.
    const exp = new Date(Date.now() + 3600_000);
    await db.insert(sessions).values([
      { userId: userIds[0]!, expiresAt: exp, ip: "203.0.113.7", fingerprint: `dev-${suffix}` },
      { userId: userIds[1]!, expiresAt: exp, ip: "203.0.113.7", fingerprint: `dev-${suffix}` },
      { userId: userIds[2]!, expiresAt: exp, ip: "198.51.100.9", fingerprint: `other-${suffix}` },
    ]);
    // C feeds B a lot of wood.
    const pC = ps.find((p) => p.userId === userIds[2])!.id;
    const pB = ps.find((p) => p.userId === userIds[1])!.id;
    await db.insert(transfers).values({ matchId, fromPlayerId: pC, toPlayerId: pB, resource: "wood", amount: 6000, via: "transport" });
  });

  afterAll(async () => {
    await db.delete(fairplayFlags).where(inArray(fairplayFlags.userA, userIds));
    await db.delete(matches).where(eq(matches.id, matchId));
    await db.delete(users).where(inArray(users.id, userIds));
    await db.close();
  });

  it("flags shared ip, shared device and heavy one-way transfers, and is idempotent", async () => {
    const created = await detectMultiAccounts(db);
    expect(created).toBeGreaterThanOrEqual(3);
    const flags = await db.select().from(fairplayFlags).where(and(eq(fairplayFlags.matchId, matchId)));
    const reasons = flags.map((f) => f.reason).sort();
    expect(reasons).toEqual(expect.arrayContaining(["shared_ip", "shared_fingerprint", "resource_transfers"]));
    const [a, b] = [userIds[0]!, userIds[1]!].sort();
    expect(flags.some((f) => f.reason === "shared_ip" && f.userA === a && f.userB === b)).toBe(true);
    const again = await detectMultiAccounts(db);
    const after = await db.select().from(fairplayFlags).where(eq(fairplayFlags.matchId, matchId));
    expect(after.length).toBe(flags.length);
    void again;
  });
});
