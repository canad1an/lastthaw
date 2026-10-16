/**
 * Invite a player: create an approved account with a placeholder tribe name
 * and no usable password, then mail them a link to set one. After logging in
 * they pick their tribe name once on the profile page.
 *
 *   node dist/scripts/inviteUser.js "kyle@example.com" "Kyle Adam"     (production, inside the api image)
 *   npx tsx src/scripts/inviteUser.ts "kyle@example.com" "Kyle Adam"   (local)
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb, type Db } from "../db/client.js";
import { matches, users } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import { issueToken } from "../auth/routes.js";
import { inviteMail, sendMail } from "../mail.js";

export const INVITE_DAYS = 7;

/** Create (or reuse) the account and return the token for the password link; the caller sends the mail. */
export async function inviteUser(db: Db, email: string, displayName: string): Promise<{ id: string; token: string; created: boolean }> {
  const normalized = email.trim().toLowerCase();
  const [existing] = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  let id = existing?.id;
  let created = false;
  if (!id) {
    const [u] = await db
      .insert(users)
      .values({ email: normalized, displayName: displayName.trim(), passwordHash: await hashPassword(randomBytes(32).toString("base64url")), approvedAt: new Date(), canRename: true })
      .returning({ id: users.id });
    id = u!.id;
    created = true;
  } else {
    await db.update(users).set({ approvedAt: existing!.approvedAt ?? new Date() }).where(eq(users.id, id));
  }
  const token = await issueToken(db, id, "reset", INVITE_DAYS * 24);
  return { id, token, created };
}

const arg = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (arg.endsWith("/inviteUser.js") || arg.endsWith("/inviteUser.ts")) {
  const [email, name, code] = process.argv.slice(2);
  if (!email || !name) {
    console.error('usage: inviteUser <email> "<name>" [inviteCode]');
    process.exit(2);
  }
  const db = createDb();
  const r = await inviteUser(db, email, name);
  // A private game's invite code goes in the mail with the game's name.
  let game: { name: string; code: string } | undefined;
  if (code) {
    const [mm] = await db.select({ name: matches.name }).from(matches).where(sql`upper(${matches.settings}->>'inviteCode') = ${code.toUpperCase()} and ${matches.status} = 'lobby'`).limit(1);
    if (!mm) {
      console.error(`no open private game has the invite code ${code}`);
      await db.close();
      process.exit(2);
    }
    game = { name: mm.name, code: code.toUpperCase() };
  }
  const mail = inviteMail(name, r.token, INVITE_DAYS, game);
  await sendMail(email.trim().toLowerCase(), mail.subject, mail.text);
  console.log(JSON.stringify({ id: r.id, created: r.created, mailed: true }));
  await db.close();
}
