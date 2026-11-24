import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../../../test/support/db.ts";
import { migrate } from "../src/migrations.ts";

test("migrate is idempotent", async () => {
  const db = await createTestDb();
  try {
    await migrate(db);
    await migrate(db);
    const { rows } = await db.query<{ version: number }>("SELECT version FROM schema_migrations");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.version, 1);
    await db.query("SELECT 1 FROM oidc_models LIMIT 1");
    await db.query("SELECT 1 FROM pending_logins LIMIT 1");
  } finally {
    await db.close();
  }
});
