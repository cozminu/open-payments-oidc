import type { Db } from "./db.ts";

export type PendingLogin = {
  uid: string;
  walletAddress: string;
  authServerUrl: string;
  clientNonce: string;
  interactNonce: string;
  continueUrl: string;
  continueAccessToken: string;
};

export class PendingLoginRepo {
  private readonly db: Db;
  private readonly ttlSeconds: number;

  constructor(db: Db, ttlSeconds = 600) {
    this.db = db;
    this.ttlSeconds = ttlSeconds;
  }

  // Upserts by uid: a user who resubmits the form replaces the earlier attempt.
  async save(login: PendingLogin): Promise<void> {
    await this.db.query(
      `INSERT INTO pending_logins (uid, details, expires_at)
       VALUES ($1, $2::jsonb, now() + ($3::float8 * interval '1 second'))
       ON CONFLICT (uid) DO UPDATE SET
         details = EXCLUDED.details, expires_at = EXCLUDED.expires_at`,
      [login.uid, JSON.stringify(login), this.ttlSeconds],
    );
  }

  // Single-use and atomic across replicas: one DELETE ... RETURNING, so only one caller wins.
  async take(uid: string): Promise<PendingLogin | undefined> {
    const { rows } = await this.db.query<{ details: PendingLogin }>(
      "DELETE FROM pending_logins WHERE uid = $1 AND expires_at > now() RETURNING details",
      [uid],
    );
    return rows[0]?.details;
  }
}
