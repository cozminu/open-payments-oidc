import { openDatabase, type DatabaseInput, type Db } from "./db.ts";
import { silentLogger, type Logger } from "./log.ts";
import { deleteExpiredPendingLogins, migrateWalletLogin } from "./migrations.ts";

export type PendingLogin = {
  walletAddress: string;
  authServerUrl: string;
  clientNonce: string;
  interactNonce: string;
  continueUrl: string;
  continueAccessToken: string;
};

/** Holds a started login until the wallet redirects back. `id` is the interaction uid. */
export type PendingLoginStore = {
  /** Upserts by id: a user who resubmits the form replaces the earlier attempt. */
  save(id: string, login: PendingLogin, ttlSeconds: number): Promise<void>;
  /** Single use: returns the login and removes it; one caller wins when several race. */
  take(id: string): Promise<PendingLogin | undefined>;
  close?(): Promise<void>;
};

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** In-process store for single-instance deployments and tests. Entries die with the process. */
export function memoryStore(options: { now?: () => number } = {}): PendingLoginStore {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { login: PendingLogin; expiresAt: number }>();
  return {
    async save(id, login, ttlSeconds) {
      entries.set(id, { login: { ...login }, expiresAt: now() + ttlSeconds * 1000 });
    },
    async take(id) {
      const entry = entries.get(id);
      entries.delete(id);
      if (entry === undefined || entry.expiresAt <= now()) return undefined;
      return entry.login;
    },
  };
}

export async function postgresStore(options: {
  database: DatabaseInput;
  /** Delete expired rows every 10 minutes. Default true. */
  cleanup?: boolean;
  log?: Logger;
}): Promise<PendingLoginStore> {
  const log = options.log ?? silentLogger;
  const { db, owned } = openDatabase(options.database, log);
  try {
    await migrateWalletLogin(db);
  } catch (error) {
    if (owned) await db.close().catch(() => {});
    throw error;
  }

  let timer: NodeJS.Timeout | undefined;
  if (options.cleanup !== false) {
    timer = setInterval(() => {
      deleteExpiredPendingLogins(db).then(
        (pendingLogins) => log.info("cleanup.done", { pendingLogins }),
        (error: unknown) =>
          log.error("cleanup.failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    }, CLEANUP_INTERVAL_MS);
    timer.unref();
  }

  let closing: Promise<void> | undefined;
  return {
    ...postgresQueries(db),
    close() {
      closing ??= (async () => {
        clearInterval(timer);
        if (owned) await db.close();
      })();
      return closing;
    },
  };
}

function postgresQueries(db: Db): Pick<PendingLoginStore, "save" | "take"> {
  return {
    async save(id, login, ttlSeconds) {
      // uid stays in the jsonb so rows look like the old code's and a rollback keeps working.
      await db.query(
        `INSERT INTO pending_logins (uid, details, expires_at)
         VALUES ($1, $2::jsonb, now() + ($3::float8 * interval '1 second'))
         ON CONFLICT (uid) DO UPDATE SET
           details = EXCLUDED.details, expires_at = EXCLUDED.expires_at`,
        [id, JSON.stringify({ ...login, uid: id }), ttlSeconds],
      );
    },
    // One DELETE ... RETURNING, so only one caller wins across replicas.
    async take(id) {
      const { rows } = await db.query<{ details: PendingLogin & { uid?: string } }>(
        "DELETE FROM pending_logins WHERE uid = $1 AND expires_at > now() RETURNING details",
        [id],
      );
      const details = rows[0]?.details;
      if (details === undefined) return undefined;
      const { uid: _uid, ...login } = details;
      return login;
    },
  };
}
