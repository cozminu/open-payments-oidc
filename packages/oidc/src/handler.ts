import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonWebKey } from "node:crypto";
import {
  createWalletLogin,
  deleteExpiredPendingLogins,
  migrateWalletLogin,
  openDatabase,
  parseAuthServerAllowlist,
  parseOpWallet,
  postgresStore,
  silentLogger,
  type DatabaseInput,
  type Logger,
  type OpWallet,
  type WalletLogin,
} from "@open-payments-oidc/wallet-login";
import { validateClients, type ClientConfig } from "./clients.ts";
import { InteractionHandlers, sendHtml } from "./interaction.ts";
import { parseIssuer } from "./issuer.ts";
import { validateJwks } from "./keys.ts";
import { deleteExpiredOidcModels, migrateOidc } from "./migrations.ts";
import { createOidcProvider } from "./provider.ts";
import { clientIp, RateLimiter } from "./rate-limit.ts";
import { renderErrorPage } from "./views.ts";

export type OidcHandlerConfig = {
  /** A root URL: no path, query or fragment. */
  issuer: string;
  clients: readonly ClientConfig[];
  /** Private signing keys; at least one RSA key. */
  jwks: { keys: JsonWebKey[] };
  cookieKeys: readonly string[];
  /** Default 3600. */
  sessionTtlSeconds?: number;
  /** A connection string (opened and closed by the handler), a `Db` or a `pg.Pool` (left open). */
  database: DatabaseInput;
  wallet: OpWallet;
  authServerAllowlist: readonly string[];
  /** Local development only: allows http. Default false. */
  allowHttp?: boolean;
  /** Timeout for each request to a wallet or auth server. Default 5000. */
  outboundTimeoutMs?: number;
  /** Login submissions and wallet callbacks per client IP, per process. Default 20. */
  rateLimitPerMinute?: number;
  /**
   * Trust `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`. Must be on behind a
   * TLS-offloading proxy (otherwise cookies aren't marked Secure); only behind a proxy that sets
   * them. Default false.
   */
  trustProxy?: boolean;
  /** Delete expired rows every 10 minutes. Default true. */
  cleanup?: boolean;
  /** Default: no logging. */
  log?: Logger;
};

export type OidcHandler = {
  /** Mount at the host root, before any body-parsing middleware. */
  handler(req: IncomingMessage, res: ServerResponse): void;
  /** True if the database answers. */
  ready(): Promise<boolean>;
  /** Idempotent. Stops the cleanup timer and closes what the handler opened. */
  close(): Promise<void>;
};

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

export const RATE_LIMITED_MESSAGE = "Too many attempts, wait a minute and try again.";
export const CLOSED_MESSAGE = "The service is shutting down. Please try again.";

// oidc-provider uids are URL-safe base64ish ids.
const INTERACTION_PATH_PATTERN = /^\/interaction\/([A-Za-z0-9_-]+)(\/callback)?$/;

/**
 * The OIDC provider as a plain Node `(req, res)` handler. Rejects with every config problem at
 * once; nothing is left open when it rejects.
 */
export async function createOidcHandler(config: OidcHandlerConfig): Promise<OidcHandler> {
  const log = config.log ?? silentLogger;
  const allowHttp = config.allowHttp ?? false;
  const sessionTtlSeconds = config.sessionTtlSeconds ?? 3600;
  const rateLimitPerMinute = config.rateLimitPerMinute ?? 20;
  const outboundTimeoutMs = config.outboundTimeoutMs ?? 5000;

  const errors: string[] = [];
  const issuer = parseIssuer(config.issuer ?? "", errors);
  if (config.issuer === undefined || config.issuer === "") errors.push("issuer is required");
  const keys: unknown = config.cookieKeys;
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    !keys.every((key) => typeof key === "string" && key !== "")
  ) {
    errors.push("cookieKeys must be a non-empty array of non-empty strings");
  }
  const database: unknown = config.database;
  if (
    database === undefined ||
    database === null ||
    (typeof database === "string" && database.trim() === "")
  ) {
    errors.push("database is required");
  }
  if (!isIntegerBetween(sessionTtlSeconds, 1, 31_536_000)) {
    errors.push(
      `sessionTtlSeconds must be an integer between 1 and 31536000 (got ${sessionTtlSeconds})`,
    );
  }
  if (!isIntegerBetween(rateLimitPerMinute, 1, 1_000_000)) {
    errors.push(
      `rateLimitPerMinute must be an integer between 1 and 1000000 (got ${rateLimitPerMinute})`,
    );
  }
  if (!isIntegerBetween(outboundTimeoutMs, 1, 600_000)) {
    errors.push(
      `outboundTimeoutMs must be an integer between 1 and 600000 (got ${outboundTimeoutMs})`,
    );
  }
  parseAuthServerAllowlist(config.authServerAllowlist ?? [], allowHttp, errors);
  parseOpWallet(config.wallet, errors);
  const clients = collect(errors, () => validateClients(config.clients));
  const jwks = collect(errors, () => validateJwks(config.jwks));
  if (errors.length > 0) throw new Error(`Invalid configuration:\n- ${errors.join("\n- ")}`);

  const { db, owned } = openDatabase(config.database, log);
  let timer: NodeJS.Timeout | undefined;
  let walletLogin: WalletLogin | undefined;
  try {
    await migrateWalletLogin(db);
    await migrateOidc(db);
    log.info("db.migrated");

    walletLogin = await createWalletLogin({
      wallet: config.wallet,
      authServerAllowlist: config.authServerAllowlist,
      allowHttp,
      outboundTimeoutMs,
      store: await postgresStore({ database: db, cleanup: false, log }),
      log,
    });
    const provider = createOidcProvider({
      settings: {
        issuer,
        cookieKeys: [...config.cookieKeys],
        sessionTtlSeconds,
        trustProxy: config.trustProxy ?? false,
      },
      clients: clients ?? [],
      jwks: jwks ?? { keys: [] },
      db,
      log,
    });

    if (config.cleanup !== false) {
      timer = setInterval(() => {
        Promise.all([deleteExpiredOidcModels(db), deleteExpiredPendingLogins(db)]).then(
          ([oidcModels, pendingLogins]) => log.info("cleanup.done", { oidcModels, pendingLogins }),
          (error: unknown) => log.error("cleanup.failed", { error: describeError(error) }),
        );
      }, CLEANUP_INTERVAL_MS);
      timer.unref();
    }

    const interactions = new InteractionHandlers({ provider, walletLogin, log });
    const oidcCallback = provider.callback();
    const rateLimiter = new RateLimiter({ limitPerMinute: rateLimitPerMinute });
    const trustProxy = config.trustProxy ?? false;
    const login = walletLogin;
    let closing: Promise<void> | undefined;

    // Checked before any body read, database or wallet work.
    function isRateLimited(req: IncomingMessage, res: ServerResponse): boolean {
      if (rateLimiter.allow(clientIp(req, trustProxy))) return false;
      sendHtml(res, 429, renderErrorPage(RATE_LIMITED_MESSAGE, "Too many attempts"));
      return true;
    }

    async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const rawUrl = req.url ?? "/";
      const queryStart = rawUrl.indexOf("?");
      const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
      const query = new URLSearchParams(queryStart === -1 ? "" : rawUrl.slice(queryStart + 1));
      const method = req.method ?? "GET";

      if (path === "/interaction" || path.startsWith("/interaction/")) {
        const match = INTERACTION_PATH_PATTERN.exec(path);
        const uid = match?.[1];
        if (uid === undefined) {
          sendHtml(res, 404, renderErrorPage("There's nothing here.", "Not found"));
          return;
        }
        if (match?.[2] !== undefined) {
          if (!allowMethod(res, method, ["GET"])) return;
          if (isRateLimited(req, res)) return;
          await interactions.callback(req, res, uid, query);
          return;
        }
        if (method === "GET") {
          await interactions.show(req, res, uid);
          return;
        }
        if (!allowMethod(res, method, ["POST"], ["GET", "POST"])) return;
        if (isRateLimited(req, res)) return;
        await interactions.submit(req, res, uid);
        return;
      }
      oidcCallback(req, res);
    }

    return {
      handler(req, res) {
        if (closing !== undefined) {
          sendHtml(res, 503, renderErrorPage(CLOSED_MESSAGE, "Unavailable"));
          return;
        }
        route(req, res).catch((error: unknown) => {
          log.error("http.error", {
            path: (req.url ?? "").split("?")[0],
            error: describeError(error),
          });
          if (res.headersSent) {
            res.destroy();
            return;
          }
          sendHtml(res, 500, renderErrorPage("Something went wrong. Please try again."));
        });
      },
      async ready() {
        if (closing !== undefined) return false;
        try {
          await db.query("SELECT 1");
          return true;
        } catch (error) {
          log.warn("readiness check failed", { error: describeError(error) });
          return false;
        }
      },
      close() {
        closing ??= (async () => {
          clearInterval(timer);
          await login.close();
          if (owned) await db.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    // Startup failed after the database was opened: release what we own and let the caller retry.
    clearInterval(timer);
    await walletLogin?.close().catch(() => {});
    if (owned) await db.close().catch(() => {});
    throw error;
  }
}

/** Runs `fn`, turning a thrown validation error into a collected one. */
function collect<T>(errors: string[], fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    errors.push(describeError(error));
    return undefined;
  }
}

function isIntegerBetween(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function allowMethod(
  res: ServerResponse,
  method: string,
  accepted: string[],
  advertised: string[] = accepted,
): boolean {
  if (accepted.includes(method)) return true;
  res.writeHead(405, { allow: advertised.join(", "), "content-type": "text/plain" });
  res.end("method not allowed");
  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
