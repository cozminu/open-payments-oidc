import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createOidcHandler, type OidcHandlerConfig } from "@open-payments-oidc/oidc";
import { silentLogger } from "@open-payments-oidc/wallet-login";

const SHUTDOWN_GRACE_MS = 8000;

export type ServerConfig = OidcHandlerConfig & {
  /** Default 3000. Use 0 for any free port. */
  port?: number;
  /** Interface to bind. Default: all interfaces. */
  host?: string;
};

export type RunningServer = {
  address: AddressInfo;
  /** Stops accepting connections, then closes the handler. Idempotent. */
  close(): Promise<void>;
};

/**
 * Serves the OIDC handler plus `/healthz` and `/readyz` on its own HTTP server. Rejects on any
 * startup problem (bad config lists every problem at once); nothing it opened is left open.
 * Installs no signal handlers and never exits the process.
 */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const { port = 3000, host, ...handlerConfig } = config;
  const log = config.log ?? silentLogger;

  const oidc = await createOidcHandler(handlerConfig);
  let app: Server | undefined;
  try {
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
      listening.listen({ port, host }, () => {
        listening.off("error", reject);
        resolve();
      });
    });
    // After startup, server errors are logged rather than left to crash the process.
    listening.on("error", (error) => log.error("server.error", { error: error.message }));

    const address = listening.address() as AddressInfo;
    log.info("server.listening", {
      port: address.port,
      issuer: config.issuer,
      clients: config.clients.length,
      signingKeys: config.jwks.keys.length,
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
        log.info("server.closed");
      })();
      return closing;
    };
    return { address, close };
  } catch (error) {
    // Startup failed after something was opened: release it so the caller can exit or retry.
    if (app?.listening) await new Promise<void>((resolve) => app?.close(() => resolve()));
    await oidc.close().catch(() => {});
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
