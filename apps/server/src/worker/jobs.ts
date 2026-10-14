import { eq, sql } from "drizzle-orm";
import type pino from "pino";
import type { Db } from "../db/client.js";
import { events, jobs, matches } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import type { Tx } from "../sim/regions.js";

type JobRow = typeof jobs.$inferSelect;
type MatchRow = typeof matches.$inferSelect;

const MAX_ATTEMPTS = 5;

/**
 * Complete every due job, strictly in ends_at order, each in its own
 * transaction. "Due" is measured on each match's own clock (with time skip).
 */
export async function runDueJobs(db: Db, publisher: Publisher, log: pino.Logger): Promise<void> {
  const due = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(matches, eq(matches.id, jobs.matchId))
    .where(
      sql`${jobs.completedAt} is null and ${jobs.cancelledAt} is null and ${jobs.attempts} < ${MAX_ATTEMPTS}
          and ${jobs.endsAt} <= now() + make_interval(secs => ${matches.clockOffsetSeconds})`,
    )
    .orderBy(jobs.endsAt, jobs.id)
    .limit(200);

  for (const { id } of due) {
    try {
      await db.transaction(async (tx) => {
        const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for("update", { skipLocked: true });
        if (!job || job.completedAt || job.cancelledAt) return;
        const [m] = await tx.select().from(matches).where(eq(matches.id, job.matchId)).for("update");
        if (!m) return;
        try {
          await complete(tx, publisher, m, job);
          await tx.update(jobs).set({ completedAt: job.endsAt }).where(eq(jobs.id, id));
        } catch (err) {
          await tx
            .update(jobs)
            .set({ attempts: job.attempts + 1, lastError: String((err as Error).message ?? err) })
            .where(eq(jobs.id, id));
          throw err;
        }
      });
    } catch (err) {
      log.error({ err, jobId: id }, "job failed");
    }
  }
}

/** Dispatch by job kind. Later milestones add build, research, train, mission, ice and win-hold. */
async function complete(tx: Tx, publisher: Publisher, m: MatchRow, job: JobRow): Promise<void> {
  switch (job.kind) {
    case "match_end": {
      if (m.status !== "running") return;
      await tx.update(matches).set({ status: "finished", finishedAt: job.endsAt }).where(eq(matches.id, m.id));
      await tx.insert(events).values({ matchId: m.id, at: job.endsAt, kind: "match.finished", payload: {} });
      await publisher.toMatch(m.id, "match.finished");
      return;
    }
    default:
      throw new Error(`no handler for job kind ${job.kind}`);
  }
}
