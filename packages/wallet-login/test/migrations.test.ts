import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../../../test/support/db.ts";
import { migrate as legacyMigrate } from "../../../test/support/legacy-migrate.ts";
import { deleteExpiredPendingLogins, migrateWalletLogin } from "../src/migrations.ts";
import { migrateOidc } from "../../oidc/src/migrations.ts";
import { PendingLoginRepo } from "../src/pending-logins.ts";

async function regclass(db: Awaited<ReturnType<typeof createTestDb>>, name: string) {
  const { rows } = await db.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [
    name,
  ]);
  return rows[0]?.t ?? null;
}

test("fresh database creates both tables and op_oidc_migrations rows, no schema_migrations", async () => {
  const db = await createTestDb({ migrate: false });
  try {
    await migrateWalletLogin(db);
    await migrateOidc(db);
    assert.equal(await regclass(db, "schema_migrations"), null);
    const { rows } = await db.query<{ component: string; version: number }>(
      "SELECT component, version FROM op_oidc_migrations ORDER BY component",
    );
    assert.deepEqual(rows, [
      { component: "oidc", version: 1 },
      { component: "wallet-login", version: 1 },
    ]);
  } finally {
    await db.close();
  }
});

test("wallet-only install creates only pending_logins", async () => {
  const db = await createTestDb({ migrate: false });
  try {
    await migrateWalletLogin(db);
    assert.equal(await regclass(db, "oidc_models"), null);
    assert.equal(await regclass(db, "pending_logins"), "pending_logins");
  } finally {
    await db.close();
  }
});

test("legacy database is adopted without rerunning version 1", async () => {
  const db = await createTestDb({ migrate: false });
  try {
    await legacyMigrate(db);
    await db.query("INSERT INTO oidc_models (model, id, payload) VALUES ('Session', 'a', '{}')");
    await db.query(
      "INSERT INTO pending_logins (uid, details, expires_at) VALUES ('u', '{}', now() + interval '1 hour')",
    );
    await migrateWalletLogin(db);
    await migrateOidc(db);
    assert.equal((await db.query("SELECT 1 FROM oidc_models")).rows.length, 1);
    assert.equal((await db.query("SELECT 1 FROM pending_logins")).rows.length, 1);
    const { rows } = await db.query<{ component: string; version: number }>(
      "SELECT component, version FROM op_oidc_migrations ORDER BY component",
    );
    assert.deepEqual(rows, [
      { component: "oidc", version: 1 },
      { component: "wallet-login", version: 1 },
    ]);
  } finally {
    await db.close();
  }
});

test("old code still starts after the new code adopted a legacy database", async () => {
  const db = await createTestDb({ migrate: false });
  try {
    await legacyMigrate(db);
    await migrateWalletLogin(db);
    await migrateOidc(db);
    await legacyMigrate(db);
  } finally {
    await db.close();
  }
});

test("rerunning is a no-op", async () => {
  const db = await createTestDb({ migrate: false });
  try {
    await migrateWalletLogin(db);
    await migrateOidc(db);
    await migrateWalletLogin(db);
    await migrateOidc(db);
    const { rows } = await db.query("SELECT 1 FROM op_oidc_migrations");
    assert.equal(rows.length, 2);
  } finally {
    await db.close();
  }
});

test("deleteExpiredPendingLogins removes only expired rows", async () => {
  const db = await createTestDb();
  try {
    const repo = new PendingLoginRepo(db);
    const base = {
      walletAddress: "w",
      authServerUrl: "a",
      clientNonce: "c",
      interactNonce: "i",
      continueUrl: "u",
      continueAccessToken: "t",
    };
    await repo.save({ ...base, uid: "old" });
    await repo.save({ ...base, uid: "fresh" });
    await db.query(
      "UPDATE pending_logins SET expires_at = now() - interval '1 second' WHERE uid = $1",
      ["old"],
    );
    assert.equal(await deleteExpiredPendingLogins(db), 1);
    const pending = await db.query<{ uid: string }>("SELECT uid FROM pending_logins");
    assert.deepEqual(
      pending.rows.map((r) => r.uid),
      ["fresh"],
    );
    assert.equal(await deleteExpiredPendingLogins(db), 0);
  } finally {
    await db.close();
  }
});
