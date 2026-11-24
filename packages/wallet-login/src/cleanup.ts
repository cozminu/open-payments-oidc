import type { Db } from "./db.ts";

// Expiry is judged by the database clock, same as the adapter and PendingLoginRepo.
export async function deleteExpired(
  db: Db,
): Promise<{ oidcModels: number; pendingLogins: number }> {
  const { rows } = await db.query<{ oidc_models: number; pending_logins: number }>(
    `WITH m AS (
       DELETE FROM oidc_models WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING 1
     ), p AS (
       DELETE FROM pending_logins WHERE expires_at <= now() RETURNING 1
     )
     SELECT (SELECT count(*) FROM m)::int AS oidc_models,
            (SELECT count(*) FROM p)::int AS pending_logins`,
  );
  const row = rows[0];
  return { oidcModels: row?.oidc_models ?? 0, pendingLogins: row?.pending_logins ?? 0 };
}
