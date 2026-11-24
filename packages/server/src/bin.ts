#!/usr/bin/env node
import { createLogger, type DatabaseInput } from "@open-payments-oidc/wallet-login";
import { configFromEnv } from "./env.ts";
import { startServer, type RunningServer } from "./start-server.ts";

/**
 * Reads the environment and the files it points to, then starts the server. Rejects on any
 * startup problem (bad config lists every problem at once); nothing is left open when it does.
 */
export async function runFromEnv(
  env: Record<string, string | undefined>,
  deps: { database?: DatabaseInput } = {},
): Promise<RunningServer> {
  const log = createLogger();
  const config = configFromEnv(env);
  return startServer({ ...config, database: deps.database ?? config.database, log });
}

async function run(): Promise<void> {
  const log = createLogger();
  let running: RunningServer;
  try {
    running = await runFromEnv(process.env);
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
