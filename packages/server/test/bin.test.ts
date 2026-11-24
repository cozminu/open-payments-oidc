import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateJwks } from "../src/generate-jwks.ts";
import { runFromEnv } from "../src/bin.ts";
import { createTestDb } from "../../../test/support/db.ts";

test("runFromEnv fails fast on bad config, listing the missing vars", async () => {
  await assert.rejects(runFromEnv({}), (err: Error) => {
    for (const name of [
      "ISSUER",
      "DATABASE_URL",
      "OP_WALLET_ADDRESS",
      "OP_KEY_ID",
      "OP_PRIVATE_KEY_PATH",
      "COOKIE_KEYS",
    ]) {
      assert.match(err.message, new RegExp(name));
    }
    return true;
  });
});

test("runFromEnv rejects a non-root issuer before touching anything", async () => {
  await assert.rejects(
    runFromEnv({
      ISSUER: "https://id.example.com/op",
      DATABASE_URL: "postgres://127.0.0.1:1/none",
      OP_WALLET_ADDRESS: "https://wallet.example.com/provider",
      OP_KEY_ID: "k",
      OP_PRIVATE_KEY_PATH: "/nonexistent",
      COOKIE_KEYS: "a",
    }),
    /ISSUER/,
  );
});

test("runFromEnv serves requests and close() is idempotent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "main-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "jwks.json"), JSON.stringify(generateJwks({})));
  writeFileSync(
    join(dir, "clients.json"),
    JSON.stringify([
      {
        client_id: "spa",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://localhost:5173/callback"],
      },
    ]),
  );
  writeFileSync(
    join(dir, "op.pem"),
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
  );

  // Find a free port; runFromEnv() takes a fixed one.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const db = await createTestDb();
  const running = await runFromEnv(
    {
      ISSUER: `http://127.0.0.1:${port}`,
      PORT: String(port),
      DATABASE_URL: "unused",
      OP_WALLET_ADDRESS: "https://wallet.example.com/provider",
      OP_KEY_ID: "key-1",
      OP_PRIVATE_KEY_PATH: join(dir, "op.pem"),
      CLIENTS_FILE: join(dir, "clients.json"),
      JWKS_FILE: join(dir, "jwks.json"),
      COOKIE_KEYS: "test-cookie-key",
      TRUST_PROXY: "false",
    },
    { database: db },
  );
  let closed = false;
  t.after(async () => {
    if (!closed) await running.close();
  });

  const base = `http://127.0.0.1:${port}`;
  assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok");
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const discovery = await (await fetch(`${base}/.well-known/openid-configuration`)).text();
  assert.match(discovery, /wallet_address/);

  await Promise.all([running.close(), running.close()]);
  await running.close();
  closed = true;
  await assert.rejects(fetch(`${base}/healthz`));
});

test("runFromEnv names an unreadable private key file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bin-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "jwks.json"), JSON.stringify(generateJwks({})));
  writeFileSync(join(dir, "clients.json"), "[]");
  const missing = join(dir, "missing.pem");
  await assert.rejects(
    runFromEnv({
      ISSUER: "https://id.example.com",
      DATABASE_URL: "postgres://127.0.0.1:1/none",
      OP_WALLET_ADDRESS: "https://wallet.example.com/provider",
      OP_KEY_ID: "k",
      OP_PRIVATE_KEY_PATH: missing,
      CLIENTS_FILE: join(dir, "clients.json"),
      JWKS_FILE: join(dir, "jwks.json"),
      COOKIE_KEYS: "a",
    }),
    new Error(`OP_PRIVATE_KEY_PATH ${JSON.stringify(missing)} could not be read (ENOENT)`),
  );
});
