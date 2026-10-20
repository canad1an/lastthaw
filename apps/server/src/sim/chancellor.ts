import type { AdvisorReport } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { players } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import type { AdvisorRow } from "./advisors.js";
import type { MatchRow } from "../worker/jobs.js";

type PlayerRow = typeof players.$inferSelect;

/** The Chancellor's pass: research and the market. Built in the next change. */
export async function chancellorPass(_db: Db, _m: MatchRow, _p: PlayerRow, _a: AdvisorRow, _now: Date, _publisher: Publisher): Promise<AdvisorReport> {
  throw new Error("the Chancellor is not at work yet");
}
