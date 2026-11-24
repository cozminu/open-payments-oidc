import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createApp,
  createOidcProvider,
  deleteExpiredOidcModels,
  loadClients,
  loadJwks,
  migrateOidc,
  RateLimiter,
} from "@open-payments-oidc/oidc/internal";
import {
  createLogger,
  createPgDb,
  deleteExpiredPendingLogins,
  migrateWalletLogin,
  OutboundPolicy,
  postgresStore,
  SdkOpenPaymentsGateway,
  WalletVerifier,
  type Db,
  type Logger,
} from "@open-payments-oidc/wallet-login/internal";
import { loadConfig } from "./env.ts";

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 8000;

export type Running = {
  /** Stops accepting connections, stops the cleanup timer, closes the database. Idempotent. */
  close(): Promise<void>;
};

/**
 * Loads config, runs migrations, builds the app and starts listening. Rejects on any startup
 * problem (bad config lists every problem at once); nothing is left open when it does.
 */
export async function main(
  env: Record<string, string | undefined>,
  deps: { createDb?: (url: string, log?: Logger) => Db } = {},
): Promise<Running> {
  const log = createLogger();
  const config = loadConfig(env);
  const clients = loadClients(config.clientsFile);
  const jwks = loadJwks(config.jwksFile);

  const db = (deps.createDb ?? createPgDb)(config.databaseUrl, log);
  let timer: NodeJS.Timeout | undefined;
  let app: Server | undefined;
  try {
    await migrateWalletLogin(db);
    await migrateOidc(db);
    log.info("db.migrated");

    const outbound = new OutboundPolicy({
      allowHttp: config.allowHttp,
      authServerOrigins: config.authServerAllowlist,
    });
    const gateway = await SdkOpenPaymentsGateway.create({
      walletAddressUrl: config.opWalletAddress,
      keyId: config.opKeyId,
      privateKey: config.opPrivateKeyPath,
      requestTimeoutMs: config.outboundTimeoutMs,
      outbound,
    });
    const verifier = new WalletVerifier({
      gateway,
      store: await postgresStore({ database: db, cleanup: false, log }),
      log,
    });
    const provider = createOidcProvider({
      settings: {
        issuer: config.issuer,
        cookieKeys: config.cookieKeys,
        sessionTtlSeconds: config.sessionTtlSeconds,
        trustProxy: config.trustProxy,
      },
      clients,
      jwks,
      db,
      log,
    });
    app = createApp({
      provider,
      verifier,
      db,
      rateLimiter: new RateLimiter({ limitPerMinute: config.rateLimitPerMinute }),
      trustProxy: config.trustProxy,
      log,
    });

    const listening = app;
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(config.port, () => {
        listening.off("error", reject);
        resolve();
      });
    });
    // After startup, server errors are logged rather than left to crash the process.
    listening.on("error", (error) => log.error("server.error", { error: error.message }));

    timer = setInterval(() => {
      Promise.all([deleteExpiredOidcModels(db), deleteExpiredPendingLogins(db)]).then(
        ([oidcModels, pendingLogins]) => log.info("cleanup.done", { oidcModels, pendingLogins }),
        (error: unknown) =>
          log.error("cleanup.failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    }, CLEANUP_INTERVAL_MS);
    timer.unref();

    log.info("server.listening", {
      port: (listening.address() as AddressInfo).port,
      issuer: config.issuer,
      clients: clients.length,
      signingKeys: jwks.keys.length,
    });

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        clearInterval(timer);
        const stopped = new Promise<void>((resolve) => listening.close(() => resolve()));
        listening.closeIdleConnections();
        // Don't let a stuck connection hold shutdown past the usual orchestrator grace period.
        const force = setTimeout(() => listening.closeAllConnections(), SHUTDOWN_GRACE_MS);
        force.unref();
        await stopped;
        clearTimeout(force);
        await db.close();
        log.info("server.closed");
      })();
      return closing;
    };
    return { close };
  } catch (error) {
    // Startup failed after something was opened: release it so the caller can exit or retry.
    if (timer !== undefined) clearInterval(timer);
    if (app?.listening) await new Promise<void>((resolve) => app?.close(() => resolve()));
    await db.close().catch(() => {});
    throw error;
  }
}

async function run(): Promise<void> {
  const log = createLogger();
  let running: Running;
  try {
    running = await main(process.env);
  } catch (error) {
    log.error("startup.failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
  const shutdown = (signal: string): void => {
    log.info("server.shutdown", { signal });
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("shutdown.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.main) await run();
