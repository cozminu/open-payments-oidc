import pg from "pg";
import { consoleLogger } from "./log.ts";

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url });
  // Idle clients emit errors on the pool (server restart, network drop); unhandled, that kills
  // the process. Log the message only: never SQL, params or the connection string.
  pool.on("error", (err) => {
    consoleLogger.error("db.pool_error", { error: err.message });
  });
  return {
    async query<R>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as R[] };
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let destroyClient = false;
      try {
        await client.query("BEGIN");
        const result = await fn({
          async query<R>(sql: string, params?: unknown[]) {
            const r = await client.query(sql, params);
            return { rows: r.rows as R[] };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The original error is the useful one; a failed rollback means the connection is
          // probably broken, so destroy it instead of returning it to the pool.
          destroyClient = true;
        }
        throw err;
      } finally {
        client.release(destroyClient);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
