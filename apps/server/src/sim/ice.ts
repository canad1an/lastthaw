import type { Publisher } from "../realtime/publish.js";
import type { Tx } from "./regions.js";
import type { JobRow, MatchRow } from "../worker/jobs.js";

/** Ice advance. Implemented in milestone 6. */
export async function applyIceStep(_tx: Tx, _m: MatchRow, _job: JobRow, _publisher: Publisher, _after: (fn: () => Promise<void>) => void): Promise<void> {
  return;
}
