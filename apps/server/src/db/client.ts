import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(url = config().DATABASE_URL) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return Object.assign(db, { sql, close: () => sql.end({ timeout: 5 }) });
}
