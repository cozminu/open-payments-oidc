import { PGlite } from "@electric-sql/pglite";
import type { Db, Queryable } from "../../src/db/db.ts";
import { migrate } from "../../src/db/migrate.ts";

export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  const db: Db = {
    async query<R>(sql: string, params?: unknown[]) {
      const result = await pg.query<R>(sql, params);
      return { rows: result.rows };
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) =>
        fn({
          async query<R>(sql: string, params?: unknown[]) {
            const result = await tx.query<R>(sql, params);
            return { rows: result.rows };
          },
        }),
      );
    },
    async close() {
      await pg.close();
    },
  };
  await migrate(db);
  return db;
}
