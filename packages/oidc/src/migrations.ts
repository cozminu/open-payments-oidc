import { migrate, type Db, type Migration } from "@open-payments-oidc/wallet-login/internal";

// One statement per entry: PGlite's extended protocol rejects multi-statement strings.
const OIDC_MIGRATIONS: readonly Migration[] = [
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
    ],
  },
];

export function migrateOidc(db: Db): Promise<void> {
  return migrate(db, "oidc", OIDC_MIGRATIONS, "oidc_models");
}

// Expiry is judged by the database clock, same as the adapter.
export async function deleteExpiredOidcModels(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `WITH m AS (
       DELETE FROM oidc_models WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING 1
     )
     SELECT count(*)::int AS n FROM m`,
  );
  return rows[0]?.n ?? 0;
}
