import { PGlite } from "@electric-sql/pglite";
import type { Db, Queryable } from "../../packages/wallet-login/src/db.ts";
import { migrateWalletLogin } from "../../packages/wallet-login/src/migrations.ts";
import { migrateOidc } from "../../packages/oidc/src/migrations.ts";

export async function createTestDb(options: { migrate?: boolean } = {}): Promise<Db> {
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
  if (options.migrate !== false) {
    await migrateWalletLogin(db);
    await migrateOidc(db);
  }
  return db;
}
