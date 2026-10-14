import { eq } from "drizzle-orm";
import { events, matches } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import type { Tx } from "./regions.js";
import type { JobRow, MatchRow } from "../worker/jobs.js";

/** Mark the match finished. Scoring and results are filled in by milestone 6. */
export async function finishMatch(
  tx: Tx,
  m: MatchRow,
  at: Date,
  publisher: Publisher,
  after: (fn: () => Promise<void>) => void,
  winnerPlayerId: string | null,
): Promise<void> {
  if (m.status !== "running") return;
  await tx.update(matches).set({ status: "finished", finishedAt: at, winnerPlayerId }).where(eq(matches.id, m.id));
  await tx.insert(events).values({ matchId: m.id, at, kind: "match.finished", payload: { winnerPlayerId } });
  after(() => publisher.toMatch(m.id, "match.finished", { winnerPlayerId }));
}

export async function winHoldExpired(tx: Tx, m: MatchRow, job: JobRow, publisher: Publisher, after: (fn: () => Promise<void>) => void): Promise<void> {
  const winner = (job.payload as { playerId?: string }).playerId ?? null;
  await finishMatch(tx, m, job.endsAt, publisher, after, winner);
}
