import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db.ts";
import {
  memoryStore,
  postgresStore,
  type PendingLogin,
  type PendingLoginStore,
} from "../src/pending-login-store.ts";
import { createTestDb } from "../../../test/support/db.ts";

function login(overrides: Partial<PendingLogin> = {}): PendingLogin {
  return {
    walletAddress: "https://wallet.example/alice",
    authServerUrl: "https://auth.wallet.example",
    clientNonce: "client-nonce",
    interactNonce: "interact-nonce",
    continueUrl: "https://auth.wallet.example/continue/abc",
    continueAccessToken: "continue-token",
    ...overrides,
  };
}

type Harness = { store: PendingLoginStore; expire(id: string): Promise<void> };

const harnesses: Record<string, (context: TestContext) => Promise<Harness>> = {
  memory: async () => {
    let now = 1_000_000;
    const store = memoryStore({ now: () => now });
    // Memory expiry is the injected clock, so jump past the longest ttl used below.
    return { store, expire: async () => void (now += 3_600_000) };
  },
  postgres: async (context) => {
    const db = await createTestDb();
    context.after(() => db.close());
    const store = await postgresStore({ database: db, cleanup: false });
    return {
      store,
      expire: async (id) => {
        await db.query(
          "UPDATE pending_logins SET expires_at = now() - interval '1 second' WHERE uid = $1",
          [id],
        );
      },
    };
  },
};

for (const [name, make] of Object.entries(harnesses)) {
  test(`${name}: take returns what save stored, once`, async (context) => {
    const { store } = await make(context);
    await store.save("id-1", login(), 600);
    assert.deepEqual(await store.take("id-1"), login());
    assert.equal(await store.take("id-1"), undefined);
  });

  test(`${name}: take returns undefined for an unknown id`, async (context) => {
    const { store } = await make(context);
    assert.equal(await store.take("nope"), undefined);
  });

  test(`${name}: save upserts by id`, async (context) => {
    const { store } = await make(context);
    await store.save("id-1", login({ clientNonce: "first" }), 600);
    await store.save("id-1", login({ clientNonce: "second" }), 600);
    assert.equal((await store.take("id-1"))?.clientNonce, "second");
    assert.equal(await store.take("id-1"), undefined);
  });

  test(`${name}: expired logins are not returned`, async (context) => {
    const { store, expire } = await make(context);
    await store.save("id-1", login(), 600);
    await expire("id-1");
    assert.equal(await store.take("id-1"), undefined);
  });

  test(`${name}: concurrent takes, exactly one wins`, async (context) => {
    const { store } = await make(context);
    await store.save("id-1", login(), 600);
    const results = await Promise.all(Array.from({ length: 5 }, () => store.take("id-1")));
    assert.equal(results.filter((r) => r !== undefined).length, 1);
  });
}

test("postgres: save refreshes expiry using the ttl", async (context) => {
  const db = await createTestDb();
  context.after(() => db.close());
  const store = await postgresStore({ database: db, cleanup: false });
  await store.save("id-1", login(), 120);
  const { rows } = await db.query<{ ttl: number }>(
    "SELECT extract(epoch FROM expires_at - now())::float8 AS ttl FROM pending_logins",
  );
  const ttl = rows[0]?.ttl ?? 0;
  assert.ok(ttl > 100 && ttl <= 120, `unexpected ttl ${ttl}`);
});

test("postgres: rows keep uid in details, take strips it", async (context) => {
  const db = await createTestDb();
  context.after(() => db.close());
  const store = await postgresStore({ database: db, cleanup: false });
  await store.save("id-1", login(), 600);
  const { rows } = await db.query<{ details: Record<string, unknown> }>(
    "SELECT details FROM pending_logins WHERE uid = $1",
    ["id-1"],
  );
  assert.equal(rows[0]?.details["uid"], "id-1");
  const taken = await store.take("id-1");
  assert.ok(taken);
  assert.equal("uid" in taken, false);
});

test("postgres: take reads rows written by the old code", async (context) => {
  const db = await createTestDb();
  context.after(() => db.close());
  const store = await postgresStore({ database: db, cleanup: false });
  await db.query(
    `INSERT INTO pending_logins (uid, details, expires_at)
     VALUES ('old', $1::jsonb, now() + interval '10 minutes')`,
    [JSON.stringify({ ...login(), uid: "old" })],
  );
  assert.deepEqual(await store.take("old"), login());
});

test("postgres: close leaves a passed-in Db open", async (context) => {
  const db = await createTestDb();
  context.after(() => db.close());
  const store = await postgresStore({ database: db, cleanup: false });
  await store.close?.();
  const { rows } = await db.query("SELECT 1 AS one");
  assert.equal(rows.length, 1);
});

test("postgres: close is idempotent", async (context) => {
  const db: Db = await createTestDb();
  context.after(() => db.close());
  const store = await postgresStore({ database: db });
  await store.close?.();
  await store.close?.();
});

test("postgres: an unreachable connection string rejects with the connection error", async () => {
  await assert.rejects(
    postgresStore({ database: "postgres://127.0.0.1:1/none", cleanup: false }),
    /ECONNREFUSED|connect/,
  );
});
