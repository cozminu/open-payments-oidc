import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../../../test/support/db.ts";
import { createAdapterFactory } from "../src/oidc-adapter.ts";
import { deleteExpiredOidcModels } from "../src/migrations.ts";

test("deleteExpiredOidcModels removes only expired rows", async () => {
  const db = await createTestDb();
  try {
    const adapter = createAdapterFactory(db)("Session");
    await adapter.upsert("old", { a: 1 }, 60);
    await adapter.upsert("fresh", { a: 2 }, 60);
    await adapter.upsert("forever", { a: 3 });
    await db.query(
      "UPDATE oidc_models SET expires_at = now() - interval '1 second' WHERE id = $1",
      ["old"],
    );
    assert.equal(await deleteExpiredOidcModels(db), 1);
    const models = await db.query<{ id: string }>("SELECT id FROM oidc_models ORDER BY id");
    assert.deepEqual(
      models.rows.map((r) => r.id),
      ["forever", "fresh"],
    );
    assert.equal(await deleteExpiredOidcModels(db), 0);
  } finally {
    await db.close();
  }
});
