import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { parseArgs } from "node:util";
import * as oidc from "openid-client";

/**
 * A throwaway relying party for trying the provider locally: a public client using PKCE, with
 * RP-initiated logout. It isn't part of the service (the image doesn't ship it) and keeps pending
 * logins and sessions in memory.
 */
export type SampleClientOptions = {
  issuer: string;
  clientId: string;
  /** Must be registered for the client, exactly. */
  redirectUri: string;
  /** Must be registered for the client too. Default: `/` on the redirect URI's origin. */
  postLogoutRedirectUri?: string;
  log?: (line: string) => void;
};

type PendingLogin = { nonce: string; codeVerifier: string };
type Session = { sub: string; idToken: string };

// Browsers don't isolate cookies by port, so keep clear of the provider's cookie names.
const SESSION_COOKIE = "sample_client_session";

const USAGE =
  "Usage: sample-client [--issuer http://localhost:3000] [--client-id example-spa] [--port 5173]\n";

export function createSampleClient(options: SampleClientOptions): RequestListener {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const pending = new Map<string, PendingLogin>();
  const sessions = new Map<string, Session>();
  const postLogoutRedirectUri =
    options.postLogoutRedirectUri ?? new URL("/", options.redirectUri).href;
  const callbackPath = new URL(options.redirectUri).pathname;

  // Discovered per login, so a provider restarted with new keys or settings is picked up.
  async function discover(): Promise<oidc.Configuration> {
    const insecure = new URL(options.issuer).protocol === "http:";
    return oidc.discovery(new URL(options.issuer), options.clientId, undefined, oidc.None(), {
      ...(insecure ? { execute: [oidc.allowInsecureRequests] } : {}),
    });
  }

  async function login(url: URL, res: ServerResponse): Promise<void> {
    const config = await discover();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const params: Record<string, string> = {
      redirect_uri: options.redirectUri,
      scope: "openid",
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
    };
    const prompt = url.searchParams.get("prompt");
    if (prompt !== null) params.prompt = prompt;
    pending.set(state, { nonce, codeVerifier });
    res.writeHead(302, { location: oidc.buildAuthorizationUrl(config, params).href }).end();
  }

  async function callback(url: URL, res: ServerResponse): Promise<void> {
    const state = url.searchParams.get("state") ?? "";
    const login = pending.get(state);
    pending.delete(state);
    const error = url.searchParams.get("error");
    if (error !== null) {
      const description = url.searchParams.get("error_description") ?? "";
      log(`login failed: ${error}${description === "" ? "" : ` (${description})`}`);
      send(
        res,
        400,
        "Login failed",
        `<p><b>${escapeHtml(error)}</b> ${escapeHtml(description)}</p>`,
      );
      return;
    }
    if (login === undefined) {
      send(res, 400, "Login failed", "<p>Unknown or already used state. Start again.</p>");
      return;
    }
    const config = await discover();
    const tokens = await oidc.authorizationCodeGrant(config, url, {
      pkceCodeVerifier: login.codeVerifier,
      expectedState: state,
      expectedNonce: login.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (claims === undefined) throw new Error("no ID token in the token response");
    const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    const header = JSON.parse(
      Buffer.from(tokens.id_token?.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as unknown;
    const sessionId = randomBytes(24).toString("base64url");
    sessions.set(sessionId, { sub: claims.sub, idToken: tokens.id_token ?? "" });
    log(`signed in: ${claims.sub}`);
    send(
      res,
      200,
      "Signed in",
      `<p>The ID token's signature, issuer, audience, nonce and expiry were verified.</p>
<h2>ID token claims</h2>${json(claims)}
<h2>ID token header</h2>${json(header)}
<h2>Userinfo</h2>${json(userinfo)}`,
      { "set-cookie": `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax` },
    );
  }

  // Ends the provider session too. Without a local session there's no id_token_hint, so the
  // provider identifies the client by client_id.
  async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = readSessionId(req);
    const session = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (sessionId !== undefined) sessions.delete(sessionId);
    const config = await discover();
    const params: Record<string, string> = {
      client_id: options.clientId,
      post_logout_redirect_uri: postLogoutRedirectUri,
    };
    if (session !== undefined) params.id_token_hint = session.idToken;
    log(`logging out${session === undefined ? "" : `: ${session.sub}`}`);
    res
      .writeHead(302, {
        location: oidc.buildEndSessionUrl(config, params).href,
        "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      })
      .end();
  }

  function readSessionId(req: IncomingMessage): string | undefined {
    for (const pair of (req.headers.cookie ?? "").split(";")) {
      const [name, value] = pair.trim().split("=");
      if (name === SESSION_COOKIE && value !== undefined && value !== "") return value;
    }
    return undefined;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", options.redirectUri);
    if (req.method !== "GET") {
      send(res, 405, "Method not allowed", "");
      return;
    }
    if (url.pathname === "/") {
      const sessionId = readSessionId(req);
      const session = sessionId === undefined ? undefined : sessions.get(sessionId);
      const status =
        session === undefined ? "Not signed in." : `Signed in as ${escapeHtml(session.sub)}.`;
      send(
        res,
        200,
        "Sample client",
        `<p>${status}</p>
<p>Provider: ${escapeHtml(options.issuer)}<br>Client: ${escapeHtml(options.clientId)}</p>`,
      );
      return;
    }
    if (url.pathname === "/login") return login(url, res);
    if (url.pathname === "/logout") return logout(req, res);
    if (url.pathname === callbackPath) return callback(url, res);
    send(res, 404, "Not found", "");
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`error: ${message}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      send(res, 500, "Something went wrong", `<p>${escapeHtml(message)}</p>`);
    });
  };
}

function send(
  res: ServerResponse,
  status: number,
  title: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}
pre{background:#f4f4f4;padding:1rem;overflow:auto}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}
<p><a href="/login">Sign in</a> · <a href="/login?prompt=login">Sign in, approving at the wallet again</a> · <a href="/logout">Log out</a></p>
</body></html>
`;
  res.writeHead(status, { ...headers, "content-type": "text/html; charset=utf-8" }).end(html);
}

function json(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function run(args: string[]): void {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        issuer: { type: "string", default: "http://localhost:3000" },
        "client-id": { type: "string", default: "example-spa" },
        port: { type: "string", default: "5173" },
      },
    }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(2);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`Invalid port ${JSON.stringify(values.port)}\n${USAGE}`);
    process.exit(2);
  }
  const redirectUri = `http://localhost:${port}/callback`;
  const handler = createSampleClient({
    issuer: values.issuer,
    clientId: values["client-id"],
    redirectUri,
  });
  createServer(handler).listen(port, "localhost", () => {
    process.stdout.write(
      `Sample client for ${values.issuer} as ${values["client-id"]}.\n` +
        `Open http://localhost:${port}/ (redirect URI ${redirectUri} must be registered).\n`,
    );
  });
}

if (import.meta.main) run(process.argv.slice(2));
