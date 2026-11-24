import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startServer, type ServerConfig } from "../src/index.ts";
import { generateJwks } from "../src/generate-jwks.ts";
import { createTestDb } from "../../../test/support/db.ts";
import type { Db } from "@open-payments-oidc/wallet-login";

function baseConfig(database: ServerConfig["database"]): ServerConfig {
  return {
    issuer: "http://127.0.0.1:3000",
    clients: [
      {
        client_id: "spa",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://localhost:5173/callback"],
      },
    ],
    jwks: generateJwks({}),
    cookieKeys: ["test-cookie-key"],
    database,
    wallet: {
      address: "https://wallet.example.com/provider",
      keyId: "key-1",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    },
    authServerAllowlist: ["https://auth.interledger-test.dev"],
    port: 0,
    host: "127.0.0.1",
  };
}

test("startServer with port 0 serves healthz, readyz and discovery", async (t) => {
  const db = await createTestDb();
  t.after(() => db.close());
  const running = await startServer(baseConfig(db));
  t.after(() => running.close());

  assert.notEqual(running.address.port, 0);
  const base = `http://127.0.0.1:${running.address.port}`;
  assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok");
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const discovery = await (await fetch(`${base}/.well-known/openid-configuration`)).text();
  assert.match(discovery, /wallet_address/);
});

test("close is idempotent and leaves a passed-in Db open", async (t) => {
  const db = await createTestDb();
  t.after(() => db.close());
  const running = await startServer(baseConfig(db));
  const base = `http://127.0.0.1:${running.address.port}`;

  await Promise.all([running.close(), running.close()]);
  await running.close();
  await assert.rejects(fetch(`${base}/healthz`));
  assert.equal((await db.query("SELECT 1 AS one")).rows.length, 1);
});

test("listen failure releases the handler", async (t) => {
  const db = await createTestDb();
  t.after(() => db.close());
  let ended = 0;
  // Passed in, so the server doesn't own it and must never close it.
  const shared: Db = {
    ...db,
    close: async () => {
      ended += 1;
    },
  };
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const port = (occupied.address() as AddressInfo).port;

  await assert.rejects(
    startServer({ ...baseConfig(shared), port }),
    (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
  );
  assert.equal(ended, 0);

  const running = await startServer(baseConfig(shared));
  await running.close();
  assert.equal(ended, 0);
});
