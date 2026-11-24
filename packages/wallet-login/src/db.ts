import pg from "pg";
import { silentLogger, type Logger } from "./log.ts";

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** The structural subset of `pg.Pool` we use, so a pool from another copy of `pg` is accepted. */
export type PgPoolLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<{
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    release(destroy?: boolean): void;
  }>;
};

export type DatabaseInput = string | Db | PgPoolLike;

function wrapPool(pool: PgPoolLike, close: () => Promise<void>): Db {
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
    close,
  };
}

export function createPgDb(url: string, log: Logger = silentLogger): Db {
  const pool = new pg.Pool({ connectionString: url });
  // Idle clients emit errors on the pool (server restart, network drop); unhandled, that kills
  // the process. Log the message only: never SQL, params or the connection string.
  pool.on("error", (err) => {
    log.error("db.pool_error", { error: err.message });
  });
  return wrapPool(pool, () => pool.end());
}

/**
 * Turns a connection string, a `Db` or a pool-like object into a `Db`. Only a connection string
 * is owned (the caller must close it). Duck typed on purpose: a pool from another copy of `pg`
 * fails `instanceof`. No listener is attached to a passed-in pool; its error handling is the
 * caller's.
 */
export function openDatabase(
  input: DatabaseInput,
  log: Logger = silentLogger,
): { db: Db; owned: boolean } {
  if (typeof input === "string") return { db: createPgDb(input, log), owned: true };
  if ("transaction" in input) return { db: input, owned: false };
  return { db: wrapPool(input, async () => {}), owned: false };
}
