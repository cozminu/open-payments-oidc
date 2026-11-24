import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClientConfig } from "../src/clients.ts";
import type { Db } from "../../wallet-login/src/db.ts";
import { createOidcProvider } from "../src/provider.ts";
import { createTestDb } from "../../../test/support/db.ts";

function rsaKey(kid: string): JsonWebKey {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { ...privateKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } as JsonWebKey;
}

function ecKey(kid: string): JsonWebKey {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { ...privateKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" } as JsonWebKey;
}

const clients: ClientConfig[] = [
  {
    client_id: "web",
    client_secret: "web-secret-web-secret-web-secret",
    redirect_uris: ["http://127.0.0.1:9999/callback"],
  },
  {
    client_id: "spa",
    token_endpoint_auth_method: "none",
    redirect_uris: ["http://127.0.0.1:9999/callback"],
  },
];

let db: Db;
let server: Server;
let issuer: string;

before(async () => {
  db = await createTestDb();
  let handler: ((req: unknown, res: unknown) => void) | undefined;
  server = createServer((req, res) => handler?.(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const provider = createOidcProvider({
    settings: {
      issuer,
      cookieKeys: ["test-cookie-key"],
      sessionTtlSeconds: 3600,
      trustProxy: false,
    },
    clients,
    jwks: { keys: [rsaKey("rsa-1"), rsaKey("rsa-2"), ecKey("ec-1")] },
    db,
  });
  handler = provider.callback() as typeof handler;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await db.close();
});

function authUrl(params: Record<string, string>): string {
  const query = new URLSearchParams({
    response_type: "code",
    scope: "openid",
    state: "s",
    ...params,
  });
  return `${issuer}/auth?${query}`;
}

test("discovery", async () => {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(doc.response_types_supported, ["code"]);
  const scopes = doc.scopes_supported as string[];
  assert.ok(scopes.includes("openid"));
  assert.ok(!scopes.includes("email"));
  assert.ok(!scopes.includes("profile"));
  assert.ok((doc.claims_supported as string[]).includes("wallet_address"));
  assert.ok(typeof doc.end_session_endpoint === "string");
  const algs = doc.id_token_signing_alg_values_supported as string[];
  assert.ok(algs.includes("RS256"));
  assert.ok(algs.includes("ES256"));
  assert.equal(doc.revocation_endpoint, undefined);
  assert.equal(doc.introspection_endpoint, undefined);
});

test("jwks publishes all keys, public parts only", async () => {
  const res = await fetch(`${issuer}/jwks`);
  const { keys } = (await res.json()) as { keys: Record<string, unknown>[] };
  assert.equal(keys.filter((k) => k.kty === "RSA").length, 2);
  assert.equal(keys.length, 3);
  for (const key of keys) assert.equal(key.d, undefined);
});

test("public client without PKCE is rejected", async () => {
  const res = await fetch(
    authUrl({ client_id: "spa", redirect_uri: "http://127.0.0.1:9999/callback" }),
    { redirect: "manual" },
  );
  assert.equal(res.status, 303);
  const location = new URL(res.headers.get("location") ?? "");
  assert.equal(location.origin + location.pathname, "http://127.0.0.1:9999/callback");
  assert.equal(location.searchParams.get("error"), "invalid_request");
  assert.equal(location.searchParams.get("state"), "s");
});

test("public client with PKCE is sent to the interaction", async () => {
  const res = await fetch(
    authUrl({
      client_id: "spa",
      redirect_uri: "http://127.0.0.1:9999/callback",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    }),
    { redirect: "manual" },
  );
  assert.equal(res.status, 303);
  const location = res.headers.get("location") ?? "";
  assert.match(new URL(location, issuer).pathname, /^\/interaction\/[\w-]+$/);
});

test("confidential client without PKCE is allowed", async () => {
  const res = await fetch(
    authUrl({ client_id: "web", redirect_uri: "http://127.0.0.1:9999/callback" }),
    { redirect: "manual" },
  );
  assert.equal(res.status, 303);
  const location = res.headers.get("location") ?? "";
  assert.match(new URL(location, issuer).pathname, /^\/interaction\/[\w-]+$/);
});

test("unregistered redirect_uri is rejected without redirecting", async () => {
  const res = await fetch(
    authUrl({ client_id: "web", redirect_uri: "http://127.0.0.1:9999/other" }),
    { redirect: "manual" },
  );
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("location"), null);
  assert.match(await res.text(), /redirect_uri/);
});

test("implicit response type is rejected", async () => {
  const res = await fetch(
    authUrl({
      client_id: "web",
      redirect_uri: "http://127.0.0.1:9999/callback",
      response_type: "id_token",
      nonce: "n",
    }),
    { redirect: "manual" },
  );
  assert.equal(res.status, 303);
  const location = new URL(res.headers.get("location") ?? "", issuer);
  // Implicit-style response types use the fragment response mode for errors.
  assert.equal(
    new URLSearchParams(location.hash.slice(1)).get("error"),
    "unsupported_response_type",
  );
});
