import type { Db } from "./db.ts";

const MIGRATION_LOCK_ID = 7461;

export type Migration = { version: number; statements: string[] };

// One statement per entry: PGlite's extended protocol rejects multi-statement strings.
const WALLET_LOGIN_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE pending_logins (
         uid text PRIMARY KEY, details jsonb NOT NULL, expires_at timestamptz NOT NULL)`,
    ],
  },
];

/**
 * Applies a component's migrations, tracked per component in op_oidc_migrations. A database
 * created by the old single-table runner (schema_migrations) is adopted without rerunning
 * version 1 when `legacyTable` already exists. Never touches schema_migrations. The lock id is
 * the same one the old runner used, so old and new code serialize.
 */
export async function migrate(
  db: Db,
  component: string,
  migrations: readonly Migration[],
  legacyTable?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS op_oidc_migrations
         (component text NOT NULL, version int NOT NULL, PRIMARY KEY (component, version))`,
    );
    const { rows } = await tx.query<{ version: number }>(
      "SELECT version FROM op_oidc_migrations WHERE component = $1",
      [component],
    );
    const applied = new Set(rows.map((r) => r.version));
    if (applied.size === 0 && legacyTable !== undefined && (await adoptable(tx, legacyTable))) {
      await tx.query("INSERT INTO op_oidc_migrations (component, version) VALUES ($1, 1)", [
        component,
      ]);
      applied.add(1);
    }
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      for (const statement of migration.statements) {
        await tx.query(statement);
      }
      await tx.query("INSERT INTO op_oidc_migrations (component, version) VALUES ($1, $2)", [
        component,
        migration.version,
      ]);
    }
  });
}

async function adoptable(
  tx: { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> },
  legacyTable: string,
): Promise<boolean> {
  const legacy = await tx.query<{ t: string | null }>(
    "SELECT to_regclass('schema_migrations')::text AS t",
  );
  if (legacy.rows[0]?.t == null) return false;
  const v1 = await tx.query("SELECT 1 FROM schema_migrations WHERE version = 1");
  if (v1.rows.length === 0) return false;
  const table = await tx.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [
    legacyTable,
  ]);
  return table.rows[0]?.t != null;
}

export function migrateWalletLogin(db: Db): Promise<void> {
  return migrate(db, "wallet-login", WALLET_LOGIN_MIGRATIONS, "pending_logins");
}

// Expiry is judged by the database clock, same as the store.
export async function deleteExpiredPendingLogins(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `WITH p AS (DELETE FROM pending_logins WHERE expires_at <= now() RETURNING 1)
     SELECT count(*)::int AS n FROM p`,
  );
  return rows[0]?.n ?? 0;
}
