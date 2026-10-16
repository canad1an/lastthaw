import type { FastifyInstance } from "fastify";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { balance } from "@lastthaw/shared";
import type pino from "pino";
import type { Db } from "../db/client.js";
import { matches, tournamentRegistrations, users } from "../db/schema.js";
import { requireVerified } from "../auth/session.js";
import { registrationMail, reminderMail, sendMail } from "../mail.js";
import { httpError } from "../sim/commands.js";
import { idParams } from "./params.js";

/** When a tournament's lobby opens for joining: this long before the start. */
export function joinOpensAt(startsAt: Date): Date {
  return new Date(startsAt.getTime() - balance.schedule.joinOpensHours * 3600_000);
}

export function isTournament(settings: unknown): boolean {
  const s = (settings ?? {}) as { kind?: string; weekly?: boolean };
  return s.kind === "tournament" || (!s.kind && !!s.weekly);
}

/**
 * Tournaments take registrations from the moment they are announced; the
 * lobby itself (joining, picking a start) opens an hour before the start.
 * Registering sends a confirmation, and the worker mails reminders a day and
 * an hour ahead.
 */
export async function registrationRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.post("/api/matches/:id/register", async (req, reply) => {
    const user = requireVerified(req);
    if (!user.approved) throw httpError(403, "Last Thaw is in private beta: ask Matt for access before registering");
    const matchId = idParams.parse(req.params).id;
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (!isTournament(m.settings)) throw httpError(400, "only tournaments take registrations; games are joined directly");
    if (m.status !== "lobby") throw httpError(409, "that tournament has already started");
    const inserted = await db.insert(tournamentRegistrations).values({ matchId, userId: user.id }).onConflictDoNothing().returning({ id: tournamentRegistrations.id });
    if (inserted.length === 0) return { ok: true, registered: true, already: true };
    const mail = registrationMail(user.displayName, m.name, m.startsAt, joinOpensAt(m.startsAt));
    void sendMail(user.email, mail.subject, mail.text);
    return reply.code(201).send({ ok: true, registered: true, already: false });
  });

  app.delete("/api/matches/:id/register", async (req) => {
    const user = requireVerified(req);
    const matchId = idParams.parse(req.params).id;
    await db.delete(tournamentRegistrations).where(and(eq(tournamentRegistrations.matchId, matchId), eq(tournamentRegistrations.userId, user.id)));
    return { ok: true, registered: false };
  });
}

/**
 * Run from the worker every minute: everyone registered for a tournament that
 * starts within a day hears once that it is tomorrow; within an hour, once
 * that the lobby is open. Returns how many mails went out.
 */
export async function sendTournamentReminders(db: Db, log: pino.Logger, now = new Date()): Promise<number> {
  const dayAhead = new Date(now.getTime() + 24 * 3600_000);
  const hourAhead = new Date(now.getTime() + balance.schedule.joinOpensHours * 3600_000);
  const rows = await db
    .select({ reg: tournamentRegistrations, m: matches, email: users.email, name: users.displayName })
    .from(tournamentRegistrations)
    .innerJoin(matches, eq(matches.id, tournamentRegistrations.matchId))
    .innerJoin(users, eq(users.id, tournamentRegistrations.userId))
    .where(and(eq(matches.status, "lobby"), gt(matches.startsAt, now), lte(matches.startsAt, dayAhead), sql`${users.suspendedAt} is null`));
  let sent = 0;
  for (const r of rows) {
    const hour = r.m.startsAt <= hourAhead;
    if (hour && !r.reg.remindedHourAt) {
      const mail = reminderMail(r.name, r.m.name, r.m.startsAt, "hour");
      void sendMail(r.email, mail.subject, mail.text);
      await db.update(tournamentRegistrations).set({ remindedHourAt: now, remindedDayAt: r.reg.remindedDayAt ?? now }).where(eq(tournamentRegistrations.id, r.reg.id));
      sent += 1;
    } else if (!hour && !r.reg.remindedDayAt) {
      const mail = reminderMail(r.name, r.m.name, r.m.startsAt, "day");
      void sendMail(r.email, mail.subject, mail.text);
      await db.update(tournamentRegistrations).set({ remindedDayAt: now }).where(eq(tournamentRegistrations.id, r.reg.id));
      sent += 1;
    }
  }
  if (sent) log.info({ sent }, "tournament reminders sent");
  return sent;
}

void isNull;
