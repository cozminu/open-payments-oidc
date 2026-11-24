import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteExpired } from "../src/cleanup.ts";
import { PendingLoginRepo } from "../src/pending-logins.ts";
import { createAdapterFactory } from "../../oidc/src/oidc-adapter.ts";
import { createTestDb } from "../../../test/support/db.ts";

test("deleteExpired removes only expired rows in both tables", async () => {
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

    assert.deepEqual(await deleteExpired(db), { oidcModels: 1, pendingLogins: 1 });

    const models = await db.query<{ id: string }>("SELECT id FROM oidc_models ORDER BY id");
    assert.deepEqual(
      models.rows.map((r) => r.id),
      ["forever", "fresh"],
    );
    const pending = await db.query<{ uid: string }>("SELECT uid FROM pending_logins");
    assert.deepEqual(
      pending.rows.map((r) => r.uid),
      ["fresh"],
    );
    assert.deepEqual(await deleteExpired(db), { oidcModels: 0, pendingLogins: 0 });
  } finally {
    await db.close();
  }
});
