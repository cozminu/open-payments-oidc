import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../wallet-login/src/db.ts";
import { createAdapterFactory } from "../src/oidc-adapter.ts";
import { createTestDb } from "../../../test/support/db.ts";

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const db = await createTestDb();
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

test("upsert then find returns payload", async () => {
  await withDb(async (db) => {
    const adapter = createAdapterFactory(db)("AuthorizationCode");
    await adapter.upsert("code-1", { accountId: "acct", scope: "openid" }, 60);
    assert.deepEqual(await adapter.find("code-1"), { accountId: "acct", scope: "openid" });
  });
});

test("upsert overwrites an existing row", async () => {
  await withDb(async (db) => {
    const adapter = createAdapterFactory(db)("AuthorizationCode");
    await adapter.upsert("code-1", { scope: "a" }, 60);
    await adapter.upsert("code-1", { scope: "b" }, 60);
    assert.deepEqual(await adapter.find("code-1"), { scope: "b" });
  });
});

test("find returns undefined for unknown id", async () => {
  await withDb(async (db) => {
    const adapter = createAdapterFactory(db)("AuthorizationCode");
    assert.equal(await adapter.find("nope"), undefined);
  });
});

test("find returns undefined after expiry", async () => {
  await withDb(async (db) => {
    const adapter = createAdapterFactory(db)("AuthorizationCode");
    await adapter.upsert("code-1", { scope: "openid" }, 1);
    await db.query(
      "UPDATE oidc_models SET expires_at = now() - interval '1 second' WHERE model = $1 AND id = $2",
      ["AuthorizationCode", "code-1"],
    );
    assert.equal(await adapter.find("code-1"), undefined);
  });
});

test("no expiresIn stores null expiry", async () => {
  await withDb(async (db) => {
    const adapter = createAdapterFactory(db)("Session");
    await adapter.upsert("s1", { uid: "u1" });
    const { rows } = await db.query<{ expires_at: unknown }>(
      "SELECT expires_at FROM oidc_models WHERE id = 's1'",
    );
    assert.equal(rows[0]?.expires_at, null);
    assert.deepEqual(await adapter.find("s1"), { uid: "u1" });
  });
});

test("consume marks consumed", async () => {
  await withDb(async (db) => {
    const adapter = createAdapterFactory(db)("AuthorizationCode");
    await adapter.upsert("code-1", { scope: "openid" }, 60);
    assert.equal((await adapter.find("code-1"))?.consumed, undefined);
    await adapter.consume("code-1");
    const found = await adapter.find("code-1");
    assert.ok(found?.consumed);
    assert.equal(typeof found?.consumed, "number");
    assert.ok(Math.abs((found?.consumed as number) - Date.now() / 1000) < 60);
    assert.equal(found?.scope, "openid");
  });
});

test("destroy removes the row", async () => {
  await withDb(async (db) => {
    const adapter = createAdapterFactory(db)("AuthorizationCode");
    await adapter.upsert("code-1", { scope: "openid" }, 60);
    await adapter.destroy("code-1");
    assert.equal(await adapter.find("code-1"), undefined);
  });
});

test("revokeByGrantId deletes all models with that grantId", async () => {
  await withDb(async (db) => {
    const factory = createAdapterFactory(db);
    const access = factory("AccessToken");
    const code = factory("AuthorizationCode");
    await access.upsert("at-1", { grantId: "g1" }, 60);
    await code.upsert("ac-1", { grantId: "g1" }, 60);
    await code.upsert("ac-2", { grantId: "g2" }, 60);
    await access.revokeByGrantId("g1");
    assert.equal(await access.find("at-1"), undefined);
    assert.equal(await code.find("ac-1"), undefined);
    assert.deepEqual(await code.find("ac-2"), { grantId: "g2" });
  });
});

test("findByUid finds a Session by payload.uid", async () => {
  await withDb(async (db) => {
    const adapter = createAdapterFactory(db)("Session");
    await adapter.upsert("sess-1", { uid: "uid-1", accountId: "acct" }, 60);
    assert.deepEqual(await adapter.findByUid("uid-1"), { uid: "uid-1", accountId: "acct" });
    assert.equal(await adapter.findByUid("other"), undefined);
  });
});

test("findByUserCode finds a DeviceCode by payload.userCode", async () => {
  await withDb(async (db) => {
    const adapter = createAdapterFactory(db)("DeviceCode");
    await adapter.upsert("dc-1", { userCode: "ABCD" }, 60);
    assert.deepEqual(await adapter.findByUserCode("ABCD"), { userCode: "ABCD" });
  });
});

test("models are namespaced", async () => {
  await withDb(async (db) => {
    const factory = createAdapterFactory(db);
    const a = factory("AccessToken");
    const b = factory("RefreshToken");
    await a.upsert("same", { kind: "a" }, 60);
    await b.upsert("same", { kind: "b" }, 60);
    assert.deepEqual(await a.find("same"), { kind: "a" });
    assert.deepEqual(await b.find("same"), { kind: "b" });
    await a.destroy("same");
    assert.equal(await a.find("same"), undefined);
    assert.deepEqual(await b.find("same"), { kind: "b" });
  });
});
