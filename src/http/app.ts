import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import type { Db } from "../db/db.ts";
import type { Logger } from "../log.ts";
import type { WalletVerifier } from "../wallet/verifier.ts";
import { InteractionHandlers, sendHtml } from "./interaction.ts";
import { clientIp, type RateLimiter } from "./rate-limit.ts";
import { renderErrorPage } from "./views.ts";

export type AppDeps = {
  provider: Provider;
  verifier: WalletVerifier;
  db: Db;
  log: Logger;
  /** Limits login submissions and wallet callbacks per client IP. Default: no limit. */
  rateLimiter?: RateLimiter;
  /** Trust `X-Forwarded-For` for the client IP. Only behind a proxy that sets it. Default: false. */
  trustProxy?: boolean;
};

export const RATE_LIMITED_MESSAGE = "Too many attempts, wait a minute and try again.";

// oidc-provider uids are URL-safe base64ish ids.
const INTERACTION_PATH_PATTERN = /^\/interaction\/([A-Za-z0-9_-]+)(\/callback)?$/;

/** The HTTP server: health checks, the login interaction, and oidc-provider for everything else. */
export function createApp({
  provider,
  verifier,
  db,
  log,
  rateLimiter,
  trustProxy = false,
}: AppDeps): Server {
  const interactions = new InteractionHandlers({ provider, verifier, log });
  const oidcCallback = provider.callback();

  // Checked before any body read, database or wallet work.
  function isRateLimited(req: IncomingMessage, res: ServerResponse): boolean {
    if (rateLimiter === undefined || rateLimiter.allow(clientIp(req, trustProxy))) return false;
    sendHtml(res, 429, renderErrorPage(RATE_LIMITED_MESSAGE, "Too many attempts"));
    return true;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";
    const queryStart = rawUrl.indexOf("?");
    const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
    const query = new URLSearchParams(queryStart === -1 ? "" : rawUrl.slice(queryStart + 1));
    const method = req.method ?? "GET";

    if (path === "/healthz") {
      if (!allowMethod(res, method, ["GET", "HEAD"])) return;
      sendText(res, 200, "ok");
      return;
    }
    if (path === "/readyz") {
      if (!allowMethod(res, method, ["GET", "HEAD"])) return;
      let ready = true;
      try {
        await db.query("SELECT 1");
      } catch (error) {
        ready = false;
        log.warn("readiness check failed", { error: describeError(error) });
      }
      sendText(res, ready ? 200 : 503, ready ? "ok" : "unavailable");
      return;
    }
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

  return createServer((req, res) => {
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
  });
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

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
