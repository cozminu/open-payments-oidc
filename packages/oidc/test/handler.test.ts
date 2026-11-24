import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
  createLogger,
  createOidcHandler,
  type OidcHandler,
  type OidcHandlerConfig,
} from "../src/index.ts";
import { createTestDb } from "../../../test/support/db.ts";
import { rsaKey, type LogLine } from "../../../test/support/test-app.ts";
import type { Db } from "../../wallet-login/src/index.ts";

const CLIENT = {
  client_id: "spa",
  token_endpoint_auth_method: "none" as const,
  redirect_uris: ["http://127.0.0.1:9999/callback"],
};

function baseConfig(issuer: string, db: Db, logs: LogLine[] = []): OidcHandlerConfig {
  return {
    issuer,
    clients: [CLIENT],
    jwks: { keys: [rsaKey("k1")] },
    cookieKeys: ["cookie-key"],
    database: db,
    wallet: {
      address: "http://127.0.0.1:1/provider",
      keyId: "key-1",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    },
    authServerAllowlist: ["https://auth.example"],
    log: createLogger({ write: (line) => logs.push(JSON.parse(line) as LogLine) }),
  };
}

async function mounted(
  context: TestContext,
  options: { logs?: LogLine[]; wrap?: (handler: OidcHandler["handler"]) => RequestListener } = {},
): Promise<{ op: OidcHandler; url: string; db: Db }> {
  const db = await createTestDb();
  let op: OidcHandler | undefined;
  // The issuer is the server's own URL, so listen first and hand requests over once it exists.
  const server = createServer((req, res) => {
    if (op === undefined) return void res.writeHead(503).end();
    const handler = op.handler.bind(op);
    (options.wrap?.(handler) ?? handler)(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await op?.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  op = await createOidcHandler(baseConfig(url, db, options.logs));
  return { op, url, db };
}

test("mounted in a bare http server, discovery works", async (context) => {
  const { url } = await mounted(context);
  const discovery = (await (await fetch(`${url}/.well-known/openid-configuration`)).json()) as {
    claims_supported: string[];
  };
  assert.ok(discovery.claims_supported.includes("wallet_address"));
});

test("does not serve /healthz", async (context) => {
  const { url } = await mounted(context);
  const response = await fetch(`${url}/healthz`);
  assert.equal(response.status, 404);
  assert.match(await response.text(), /oidc-provider|invalid_request|not found/i);
});

test("ready() is true, then false after the db is closed", async (context) => {
  const logs: LogLine[] = [];
  const { op, db } = await mounted(context, { logs });
  assert.equal(await op.ready(), true);
  await db.close();
  assert.equal(await op.ready(), false);
  assert.ok(logs.some((line) => line.level === "warn" && line.msg === "readiness check failed"));
});

test("close leaves a passed-in Db open", async (context) => {
  const { op, db } = await mounted(context);
  await op.close();
  assert.deepEqual((await db.query("SELECT 1 AS one")).rows, [{ one: 1 }]);
});

test("close is idempotent; requests after close get 503", async (context) => {
  const { op, url } = await mounted(context);
  await Promise.all([op.close(), op.close()]);
  await op.close();
  const response = await fetch(`${url}/.well-known/openid-configuration`);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /shutting down/);
  assert.equal(await op.ready(), false);
});

test("config errors are collected", async (context) => {
  const db = await createTestDb();
  context.after(() => db.close());
  await assert.rejects(
    createOidcHandler({
      ...baseConfig("https://x.example/op", db),
      cookieKeys: [],
      clients: [{ ...CLIENT, redirect_uris: ["http://app.example/callback"] }],
      jwks: { keys: [] },
      wallet: { ...baseConfig("http://x", db).wallet, privateKey: "/secrets/op.pem" },
    }),
    (error: Error) => {
      assert.match(error.message, /^Invalid configuration:\n- /);
      assert.match(error.message, /issuer .*root URL/);
      assert.match(error.message, /cookieKeys/);
      assert.match(error.message, /redirect URI .*must be https/);
      assert.match(error.message, /at least one RSA private key/);
      assert.match(error.message, /wallet\.privateKey must be PEM text or a KeyObject/);
      return true;
    },
  );
});

test("a consumed body gets a 400, not a hang", async (context) => {
  const logs: LogLine[] = [];
  const { url } = await mounted(context, {
    logs,
    wrap: (handler) => (req, res) => {
      req.on("data", () => {});
      req.on("end", () => handler(req, res));
    },
  });
  const response = await fetch(`${url}/interaction/abc123`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "wallet_address=https%3A%2F%2Fwallet.example%2Falice",
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 400);
  assert.ok(logs.some((line) => line.level === "warn" && line.msg === "interaction.body_consumed"));
});
