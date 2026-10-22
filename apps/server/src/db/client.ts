import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Async context carried into transactions. The postgres driver runs a transaction's callback from its own connection
 * queue, outside the caller's async context, so anything stored there (the match's map) would be lost inside; the
 * wrapper below captures the stores registered here before the transaction and re-enters them inside the callback.
 */
const carried: AsyncLocalStorage<object>[] = [];
export function carryIntoTransactions(als: AsyncLocalStorage<object>): void {
  carried.push(als);
}

export type Db = ReturnType<typeof createDb>;

export function createDb(url = config().DATABASE_URL) {
  // prepare:false keeps us compatible with PgBouncer in transaction pooling mode.
  const sql = postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 10), prepare: false, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const transaction = db.transaction.bind(db);
  db.transaction = ((fn: (tx: Parameters<Parameters<typeof transaction>[0]>[0]) => Promise<unknown>, cfg?: Parameters<typeof transaction>[1]) => {
    const stores = carried.map((als) => [als, als.getStore()] as const);
    return transaction(async (tx) => {
      for (const [als, store] of stores) if (store) als.enterWith(store);
      return fn(tx);
    }, cfg);
  }) as typeof db.transaction;
  return Object.assign(db, { sql, close: () => sql.end({ timeout: 5 }) });
}
