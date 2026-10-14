import type { Publisher } from "../realtime/publish.js";
import type { Tx } from "./regions.js";
import type { JobRow, MatchRow } from "../worker/jobs.js";

/** Army arrival. Implemented in milestone 3. */
export async function resolveMission(_tx: Tx, _m: MatchRow, _job: JobRow, _publisher: Publisher, _after: (fn: () => Promise<void>) => void): Promise<void> {
  throw new Error("missions arrive in milestone 3");
}
