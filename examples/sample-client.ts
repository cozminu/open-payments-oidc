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
      sendError(res, 400, "Login failed", `<b>${escapeHtml(error)}</b> ${escapeHtml(description)}`);
      return;
    }
    if (login === undefined) {
      sendError(res, 400, "Login failed", "Unknown or already used state. Start again.");
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
    const pills = VERIFIED.map((check) => `<li>&#10003; ${check}</li>`).join("");
    send(
      res,
      200,
      "Signed in",
      `<h1>Signed in</h1>
<div class="who"><span>Signed in as <code>${escapeHtml(claims.sub)}</code></span><a class="button secondary" href="/logout">Log out</a></div>
<ul class="pills" aria-label="Verified">${pills}</ul>
<h2>ID token claims</h2>
${claimsTable(claims)}
<details>
<summary>ID token header</summary>
${json(header)}
</details>
<details>
<summary>Userinfo</summary>
${json(userinfo)}
</details>
<details>
<summary>Raw ID token</summary>
<pre class="raw">${escapeHtml(tokens.id_token ?? "")}</pre>
</details>`,
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
      sendError(res, 405, "Method not allowed", "This sample client only handles GET requests.");
      return;
    }
    if (url.pathname === "/") {
      const sessionId = readSessionId(req);
      const session = sessionId === undefined ? undefined : sessions.get(sessionId);
      send(
        res,
        200,
        "Sample client",
        session === undefined
          ? `<h1>Not signed in</h1>
<p>A test relying party for the provider: authorization code flow with PKCE, then RP-initiated logout.</p>
<div class="actions"><a class="button" href="/login">Sign in with your wallet</a><a class="button secondary" href="/login?prompt=login">Sign in, approving at the wallet again</a></div>`
          : `<h1>Signed in</h1>
<div class="who"><span>Signed in as <code>${escapeHtml(session.sub)}</code></span><a class="button secondary" href="/logout">Log out</a></div>`,
      );
      return;
    }
    if (url.pathname === "/login") return login(url, res);
    if (url.pathname === "/logout") return logout(req, res);
    if (url.pathname === callbackPath) return callback(url, res);
    sendError(res, 404, "Not found", "There's no page here.");
  }

  function send(
    res: ServerResponse,
    status: number,
    title: string,
    body: string,
    headers: Record<string, string> = {},
  ): void {
    const html = renderPage(title, body, options.issuer, options.clientId);
    res.writeHead(status, { ...headers, "content-type": "text/html; charset=utf-8" }).end(html);
  }

  // `message` is HTML; callers escape what they put in it.
  function sendError(res: ServerResponse, status: number, title: string, message: string): void {
    send(
      res,
      status,
      title,
      `<h1>${escapeHtml(title)}</h1>
<div class="callout" role="alert">${message}</div>
<p><a href="/">Back to home</a></p>`,
    );
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`error: ${message}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, 500, "Something went wrong", escapeHtml(message));
    });
  };
}

const VERIFIED = ["signature", "issuer", "audience", "nonce", "expiry"];

// Shown as readable times next to the raw number.
const TIME_CLAIMS = new Set(["exp", "iat", "auth_time"]);

// Slate, so it reads as somebody else's app next to the provider's teal and pink.
const STYLE = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
font-size:15px;line-height:1.5;color:#0f172a;background:#f8fafc}
code,pre,td,.chip{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;padding:.75rem 1.25rem;background:#0f172a;color:#e2e8f0}
.bar a{color:#fff;font-weight:600;text-decoration:none;margin-right:auto}
.bar a:focus-visible{outline:2px solid #94a3b8;outline-offset:3px;border-radius:2px}
.chip{padding:.125rem .5rem;font-size:.75rem;color:#cbd5e1;background:#1e293b;border:1px solid #334155;
border-radius:999px;overflow-wrap:anywhere}
main{max-width:48rem;margin:0 auto;padding:2rem 1.25rem 3rem}
h1{margin:0 0 .75rem;font-size:1.5rem;line-height:1.25}
h2{margin:2rem 0 .75rem;font-size:1rem}
p{margin:0 0 1rem;color:#475569;overflow-wrap:anywhere}
a{color:#2563eb}
code{font-size:.875em;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:.5rem}
.button{display:inline-block;padding:.5rem .875rem;font-size:.875rem;font-weight:600;color:#fff;background:#0f172a;
border:1px solid #0f172a;border-radius:6px;text-decoration:none}
.button:hover{background:#1e293b}
.button.secondary{color:#0f172a;background:#fff;border-color:#cbd5e1}
.button.secondary:hover{background:#f1f5f9}
.button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.who{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem;padding:.75rem 1rem;
background:#fff;border:1px solid #e2e8f0;border-radius:8px}
.who span{min-width:0;overflow-wrap:anywhere}
.pills{display:flex;flex-wrap:wrap;gap:.375rem;margin:1rem 0 0;padding:0;list-style:none}
.pills li{padding:.125rem .625rem;font-size:.8125rem;font-weight:600;color:#166534;background:#dcfce7;border-radius:999px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;
table-layout:fixed}
th,td{padding:.5rem .75rem;text-align:left;vertical-align:top;border-top:1px solid #e2e8f0;font-size:.8125rem}
tr:first-child th,tr:first-child td{border-top:0}
th{width:9rem;font-weight:600;color:#475569;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
th,td{overflow-wrap:anywhere}
.muted{color:#64748b}
details{margin:.75rem 0 0;background:#fff;border:1px solid #e2e8f0;border-radius:8px}
summary{padding:.625rem 1rem;font-weight:600;cursor:pointer}
summary:focus-visible{outline:2px solid #2563eb;outline-offset:-2px;border-radius:8px}
pre{margin:0;padding:1rem;font-size:.8125rem;overflow:auto;border-top:1px solid #e2e8f0;background:#f8fafc;
border-radius:0 0 8px 8px}
pre.raw{white-space:pre-wrap;overflow-wrap:anywhere}
.callout{margin:0 0 1rem;padding:.75rem 1rem;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;
border-radius:8px;overflow-wrap:anywhere}
@media (max-width:480px){th{width:6.5rem}main{padding:1.5rem 1rem 2rem}}
`;

function renderPage(title: string, body: string, issuer: string, clientId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="bar"><a href="/">Sample client</a><span class="chip">issuer ${escapeHtml(issuer)}</span><span class="chip">client ${escapeHtml(clientId)}</span></header>
<main>
${body}
</main>
</body>
</html>
`;
}

/** One row per claim, in the token's order. Times also shown as UTC. */
function claimsTable(claims: Record<string, unknown>): string {
  const rows = Object.entries(claims).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const time =
      TIME_CLAIMS.has(key) && typeof value === "number"
        ? ` <span class="muted">${formatUtc(value)}</span>`
        : "";
    return `<tr><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(text)}${time}</td></tr>`;
  });
  return `<table>${rows.join("")}</table>`;
}

/** `YYYY-MM-DD HH:MM:SS UTC` for a time in seconds since the epoch. */
function formatUtc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
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
