import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createOidcHandler,
  readClientsFile,
  readJwksFile,
  type OidcHandler,
} from "@open-payments-oidc/oidc";
import { createLogger, createPgDb, type Db, type Logger } from "@open-payments-oidc/wallet-login";
import { loadConfig } from "./env.ts";

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
  const clients = readClientsFile(config.clientsFile);
  const jwks = readJwksFile(config.jwksFile);

  const db = (deps.createDb ?? createPgDb)(config.databaseUrl, log);
  let handler: OidcHandler | undefined;
  let app: Server | undefined;
  try {
    handler = await createOidcHandler({
      issuer: config.issuer,
      clients,
      jwks,
      cookieKeys: config.cookieKeys,
      sessionTtlSeconds: config.sessionTtlSeconds,
      database: db,
      wallet: {
        address: config.opWalletAddress,
        keyId: config.opKeyId,
        privateKey: readFileSync(config.opPrivateKeyPath, "utf8"),
      },
      authServerAllowlist: config.authServerAllowlist,
      allowHttp: config.allowHttp,
      outboundTimeoutMs: config.outboundTimeoutMs,
      rateLimitPerMinute: config.rateLimitPerMinute,
      trustProxy: config.trustProxy,
      log,
    });
    const oidc = handler;
    app = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/healthz") {
        if (allowMethod(res, req)) sendText(res, 200, "ok");
      } else if (path === "/readyz") {
        if (!allowMethod(res, req)) return;
        void oidc
          .ready()
          .then((ready) => sendText(res, ready ? 200 : 503, ready ? "ok" : "unavailable"));
      } else {
        oidc.handler(req, res);
      }
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

    log.info("server.listening", {
      port: (listening.address() as AddressInfo).port,
      issuer: config.issuer,
      clients: clients.length,
      signingKeys: jwks.keys.length,
    });

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve) => listening.close(() => resolve()));
        listening.closeIdleConnections();
        // Don't let a stuck connection hold shutdown past the usual orchestrator grace period.
        const force = setTimeout(() => listening.closeAllConnections(), SHUTDOWN_GRACE_MS);
        force.unref();
        await stopped;
        clearTimeout(force);
        await oidc.close();
        await db.close();
        log.info("server.closed");
      })();
      return closing;
    };
    return { close };
  } catch (error) {
    // Startup failed after something was opened: release it so the caller can exit or retry.
    if (app?.listening) await new Promise<void>((resolve) => app?.close(() => resolve()));
    await handler?.close().catch(() => {});
    await db.close().catch(() => {});
    throw error;
  }
}

function allowMethod(res: ServerResponse, req: IncomingMessage): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain" });
  res.end("method not allowed");
  return false;
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
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
