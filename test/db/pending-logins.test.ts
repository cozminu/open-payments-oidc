import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/db/db.ts";
import { PendingLoginRepo, type PendingLogin } from "../../src/db/pending-logins.ts";
import { createTestDb } from "../support/db.ts";

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const db = await createTestDb();
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

function login(overrides: Partial<PendingLogin> = {}): PendingLogin {
  return {
    uid: "uid-1",
    walletAddress: "https://wallet.example/alice",
    authServerUrl: "https://auth.wallet.example",
    clientNonce: "client-nonce",
    interactNonce: "interact-nonce",
    continueUrl: "https://auth.wallet.example/continue/abc",
    continueAccessToken: "continue-token",
    ...overrides,
  };
}

test("take returns the saved login once", async () => {
  await withDb(async (db) => {
    const repo = new PendingLoginRepo(db);
    await repo.save(login());
    assert.deepEqual(await repo.take("uid-1"), login());
    assert.equal(await repo.take("uid-1"), undefined);
  });
});

test("take returns undefined for unknown uid", async () => {
  await withDb(async (db) => {
    assert.equal(await new PendingLoginRepo(db).take("nope"), undefined);
  });
});

test("take ignores expired", async () => {
  await withDb(async (db) => {
    const repo = new PendingLoginRepo(db);
    await repo.save(login());
    await db.query(
      "UPDATE pending_logins SET expires_at = now() - interval '1 second' WHERE uid = $1",
      ["uid-1"],
    );
    assert.equal(await repo.take("uid-1"), undefined);
  });
});

test("save replaces an existing uid", async () => {
  await withDb(async (db) => {
    const repo = new PendingLoginRepo(db);
    await repo.save(login({ clientNonce: "first" }));
    await repo.save(login({ clientNonce: "second" }));
    const { rows } = await db.query("SELECT uid FROM pending_logins");
    assert.equal(rows.length, 1);
    assert.equal((await repo.take("uid-1"))?.clientNonce, "second");
  });
});

test("save refreshes expiry using the ttl", async () => {
  await withDb(async (db) => {
    const repo = new PendingLoginRepo(db, 120);
    await repo.save(login());
    const { rows } = await db.query<{ ttl: number }>(
      "SELECT extract(epoch FROM expires_at - now())::float8 AS ttl FROM pending_logins",
    );
    const ttl = rows[0]?.ttl ?? 0;
    assert.ok(ttl > 100 && ttl <= 120, `unexpected ttl ${ttl}`);
  });
});

test("concurrent take yields one winner", async () => {
  await withDb(async (db) => {
    const repo = new PendingLoginRepo(db);
    await repo.save(login());
    const results = await Promise.all([repo.take("uid-1"), repo.take("uid-1")]);
    assert.equal(results.filter((r) => r !== undefined).length, 1);
  });
});
