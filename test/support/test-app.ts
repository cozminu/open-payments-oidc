import { generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import * as oidc from "openid-client";
import type Provider from "oidc-provider";
import type { ClientConfig } from "../../src/config/clients.ts";
import type { Config } from "../../src/config/env.ts";
import type { Db } from "../../src/db/db.ts";
import { PendingLoginRepo } from "../../src/db/pending-logins.ts";
import { createApp } from "../../src/http/app.ts";
import { RateLimiter } from "../../src/http/rate-limit.ts";
import { createLogger } from "../../src/log.ts";
import { createOidcProvider } from "../../src/oidc/provider.ts";
import { AuthServerAllowlist } from "../../src/wallet/address.ts";
import { WalletVerifier } from "../../src/wallet/verifier.ts";
import { createTestDb } from "./db.ts";
import {
  createFakeOpenPayments,
  createTestClient,
  type Fake,
  type FakeOptions,
} from "./fake-open-payments.ts";

export const REDIRECT_URI = "http://127.0.0.1:9999/callback";

export const WEB_CLIENT: ClientConfig = {
  client_id: "web",
  client_secret: "web-secret-web-secret-web-secret",
  redirect_uris: [REDIRECT_URI],
};

export const SPA_CLIENT: ClientConfig = {
  client_id: "spa",
  token_endpoint_auth_method: "none",
  redirect_uris: [REDIRECT_URI],
};

// Shared by every app in the process, so two instances (replicas) sign and verify alike.
const JWKS = { keys: [rsaKey("test-rsa-1")] };
const COOKIE_KEYS = ["test-cookie-key-1"];

export function rsaKey(kid: string): JsonWebKey {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { ...privateKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } as JsonWebKey;
}

/** One parsed log line, as written by the real JSON logger. */
export type LogLine = { time: string; level: "info" | "warn" | "error"; msg: string } & Record<
  string,
  unknown
>;

/**
 * Minimal browser cookie jar. Every server in the tests is on 127.0.0.1 and cookies don't isolate
 * by port, so only the path is matched (like a browser would for one host).
 */
export class CookieJar {
  private readonly cookies = new Map<string, { value: string; path: string }>();

  async fetch(url: URL | string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    const headers = new Headers(init.headers);
    const cookie = this.header(target.pathname);
    if (cookie !== "") headers.set("cookie", cookie);
    const response = await fetch(target, { ...init, headers, redirect: "manual" });
    this.store(response.headers.getSetCookie());
    return response;
  }

  private header(path: string): string {
    const pairs: string[] = [];
    for (const [key, cookie] of this.cookies) {
      if (pathMatches(path, cookie.path)) pairs.push(`${key.split(" ")[1]}=${cookie.value}`);
    }
    return pairs.join("; ");
  }

  private store(setCookies: string[]): void {
    for (const line of setCookies) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      let path = "/";
      let expired = value === "";
      for (const attribute of attributes) {
        const [rawKey = "", rawValue = ""] = attribute.split("=");
        const key = rawKey.toLowerCase();
        if (key === "path") path = rawValue;
        if (key === "expires" && Date.parse(rawValue) <= Date.now()) expired = true;
        if (key === "max-age" && Number(rawValue) <= 0) expired = true;
      }
      const key = `${path} ${name}`;
      if (expired) {
        this.cookies.delete(key);
      } else {
        this.cookies.set(key, { value, path });
      }
    }
  }
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  return (
    requestPath === cookiePath ||
    (requestPath.startsWith(cookiePath) &&
      (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"))
  );
}

export type LoginOptions = {
  client?: "web" | "spa";
  prompt?: string;
  maxAge?: number;
  /** Submitted in order until one is accepted (303). Default: the fake's wallet address. */
  walletAddresses?: string[];
  /** Reuse a browser (and so its OIDC session). */
  jar?: CookieJar;
  /** Stop once the wallet has redirected back, without visiting the callback. */
  stopBeforeCallback?: boolean;
  /** Send the callback to this origin instead (another replica). */
  callbackOrigin?: string;
};

export type PageResponse = { url: string; status: number; html: string };

export type LoginResult = {
  jar: CookieJar;
  state: string;
  nonce: string;
  /** Set when an interaction page was shown (not when an existing session was reused). */
  interaction?: PageResponse;
  /** One response per submitted wallet address. */
  formResponses: PageResponse[];
  /** Interact URL at the wallet's auth server. */
  walletRedirect?: string;
  /** Finish redirect from the wallet, as sent by it (before any callbackOrigin rewrite). */
  callbackUrl?: URL;
  /** The callback page when it didn't redirect (an error page). */
  callbackPage?: PageResponse;
  /** Where the OP finally sent the browser at the client. */
  redirect?: URL;
  error?: string;
  tokens?: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  claims?: oidc.IDToken;
  config: oidc.Configuration;
};

export type TestApp = {
  url: string;
  issuer: string;
  fake: Fake;
  db: Db;
  provider: Provider;
  /** Parsed form of `lines`, in order. */
  logs: LogLine[];
  /** Everything logged, exactly as written (one JSON object per line, no newline). */
  lines: string[];
  /** Drives a whole browser login (manual redirects, cookie jar) and exchanges the code. */
  login(opts?: LoginOptions): Promise<LoginResult>;
  /** Client-side openid-client configuration for a registered client. */
  clientConfig(client?: "web" | "spa"): Promise<oidc.Configuration>;
};

export type TestAppOptions = {
  fake?: FakeOptions;
  /** Use this fake instead of starting one (e.g. a second replica). */
  externalFake?: Fake;
  /** Use this db and leave closing it to the caller. */
  db?: Db;
  clients?: ClientConfig[];
  /** Issuer to configure instead of this instance's own URL (a second replica of another app). */
  issuer?: string;
  /** Rate limit POST /interaction/:uid and the callback per client IP. Default: no limiter. */
  limitPerMinute?: number;
  /** Signing keys instead of the shared test key. Instances that must agree share one value. */
  jwks?: { keys: JsonWebKey[] };
};

export async function startTestApp(
  context: TestContext,
  options: TestAppOptions = {},
): Promise<TestApp> {
  const fake = options.externalFake ?? (await createFakeOpenPayments(context, options.fake));
  const ownsDb = options.db === undefined;
  const db = options.db ?? (await createTestDb());

  // The issuer has to be the app's URL and is fixed when the provider is built, so listen first
  // and hand requests to the app once it exists.
  let app: ReturnType<typeof createApp> | undefined;
  const server = createServer((req, res) => {
    if (app === undefined) {
      res.writeHead(503).end();
      return;
    }
    app.emit("request", req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (ownsDb) await db.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const issuer = options.issuer ?? url;

  const config: Config = {
    issuer,
    port: 0,
    databaseUrl: "unused",
    opWalletAddress: "http://127.0.0.1:1/provider",
    opKeyId: "test-key",
    opPrivateKeyPath: "unused",
    clientsFile: "unused",
    jwksFile: "unused",
    cookieKeys: COOKIE_KEYS,
    sessionTtlSeconds: 3600,
    authServerAllowlist: [fake.url],
    allowHttp: true,
    trustProxy: false,
    rateLimitPerMinute: 1000,
    outboundTimeoutMs: 5000,
  };
  const clients = options.clients ?? [WEB_CLIENT, SPA_CLIENT];
  const logs: LogLine[] = [];
  const lines: string[] = [];
  const log = createLogger({
    write: (line) => {
      lines.push(line);
      logs.push(JSON.parse(line) as LogLine);
    },
  });
  const provider = createOidcProvider({ config, clients, jwks: options.jwks ?? JWKS, db, log });
  const verifier = new WalletVerifier({
    client: await createTestClient(context),
    pendingLogins: new PendingLoginRepo(db),
    allowlist: new AuthServerAllowlist(config.authServerAllowlist),
    allowHttp: true,
    log,
  });
  app = createApp({
    provider,
    verifier,
    db,
    log,
    trustProxy: false,
    ...(options.limitPerMinute === undefined
      ? {}
      : { rateLimiter: new RateLimiter({ limitPerMinute: options.limitPerMinute }) }),
  });

  async function clientConfig(choice: "web" | "spa" = "web"): Promise<oidc.Configuration> {
    const client = choice === "web" ? WEB_CLIENT : SPA_CLIENT;
    const auth =
      client.client_secret === undefined
        ? oidc.None()
        : oidc.ClientSecretBasic(client.client_secret);
    return oidc.discovery(new URL(issuer), client.client_id, undefined, auth, {
      execute: [oidc.allowInsecureRequests],
    });
  }

  async function login(opts: LoginOptions = {}): Promise<LoginResult> {
    const choice = opts.client ?? "web";
    const config = await clientConfig(choice);
    const jar = opts.jar ?? new CookieJar();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifierCode = oidc.randomPKCECodeVerifier();
    const params: Record<string, string> = {
      redirect_uri: REDIRECT_URI,
      scope: "openid",
      state,
      nonce,
    };
    if (choice === "spa") {
      params.code_challenge = await oidc.calculatePKCECodeChallenge(verifierCode);
      params.code_challenge_method = "S256";
    }
    if (opts.prompt !== undefined) params.prompt = opts.prompt;
    if (opts.maxAge !== undefined) params.max_age = String(opts.maxAge);

    const result: LoginResult = { jar, state, nonce, formResponses: [], config };

    const finish = async (redirect: URL): Promise<LoginResult> => {
      result.redirect = redirect;
      const error = redirect.searchParams.get("error");
      if (error !== null) {
        result.error = error;
        return result;
      }
      const tokens = await oidc.authorizationCodeGrant(config, redirect, {
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
        ...(choice === "spa" ? { pkceCodeVerifier: verifierCode } : {}),
      });
      result.tokens = tokens;
      result.claims = tokens.claims();
      return result;
    };

    const start = await follow(jar, oidc.buildAuthorizationUrl(config, params));
    if (start.redirect !== undefined) return finish(start.redirect);
    result.interaction = start.page;
    if (start.page.status !== 200) return result;

    let walletRedirect: string | undefined;
    for (const address of opts.walletAddresses ?? [fake.walletAddress]) {
      const response = await jar.fetch(start.page.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ wallet_address: address }).toString(),
      });
      const location = response.headers.get("location");
      result.formResponses.push({
        url: start.page.url,
        status: response.status,
        html: await response.text(),
      });
      if (response.status === 303 && location !== null) {
        walletRedirect = new URL(location, start.page.url).href;
        break;
      }
    }
    if (walletRedirect === undefined) return result;
    if (!walletRedirect.startsWith(fake.url)) {
      // The interaction was finished with an error instead of going to the wallet.
      const after = await follow(jar, walletRedirect);
      if (after.redirect !== undefined) return finish(after.redirect);
      return result;
    }
    result.walletRedirect = walletRedirect;
    result.callbackUrl = await fake.interact(walletRedirect);
    if (opts.stopBeforeCallback) return result;

    const callbackTarget = new URL(result.callbackUrl);
    if (opts.callbackOrigin !== undefined) {
      const origin = new URL(opts.callbackOrigin);
      callbackTarget.protocol = origin.protocol;
      callbackTarget.host = origin.host;
    }
    const callback = await follow(jar, callbackTarget);
    if (callback.redirect !== undefined) return finish(callback.redirect);
    result.callbackPage = callback.page;
    return result;
  }

  return { url, issuer, fake, db, provider, logs, lines, login, clientConfig };
}

/** Follows redirects like a browser until a page, or until the browser is sent to the client. */
export async function follow(
  jar: CookieJar,
  url: URL | string,
): Promise<{ redirect: URL; page?: undefined } | { redirect?: undefined; page: PageResponse }> {
  let current = new URL(url);
  for (let hop = 0; hop < 10; hop++) {
    const response = await jar.fetch(current);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      const next = new URL(location, current);
      if (next.href.startsWith(REDIRECT_URI)) return { redirect: next };
      current = next;
      continue;
    }
    return { page: { url: current.href, status: response.status, html: await response.text() } };
  }
  throw new Error(`too many redirects, last at ${current.href}`);
}
