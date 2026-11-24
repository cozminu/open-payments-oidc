import type { Db } from "./db.ts";

const MIGRATION_LOCK_ID = 7461;

// One statement per entry: PGlite's extended protocol rejects multi-statement strings.
const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE oidc_models (
         model text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
         grant_id text, user_code text, uid text,
         expires_at timestamptz, consumed_at timestamptz,
         PRIMARY KEY (model, id))`,
      "CREATE INDEX oidc_models_grant_id ON oidc_models (grant_id)",
      "CREATE INDEX oidc_models_uid ON oidc_models (uid)",
      "CREATE INDEX oidc_models_user_code ON oidc_models (user_code)",
      "CREATE INDEX oidc_models_expires_at ON oidc_models (expires_at)",
      `CREATE TABLE pending_logins (
         uid text PRIMARY KEY, details jsonb NOT NULL, expires_at timestamptz NOT NULL)`,
    ],
  },
];

export async function migrate(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await tx.query("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY)");
    const { rows } = await tx.query<{ version: number }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      for (const statement of migration.statements) {
        await tx.query(statement);
      }
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
    }
  });
}
