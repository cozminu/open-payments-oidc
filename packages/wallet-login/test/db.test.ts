import { test, mock } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPgDb, openDatabase } from "../src/db.ts";
import { createLogger } from "../src/log.ts";

test("pool error handler logs a single JSON line on stdout with the message only", () => {
  const handlers: Record<string, (err: Error) => void> = {};
  mock.method(pg.Pool.prototype, "on", (event: string, fn: (err: Error) => void) => {
    handlers[event] = fn;
  });
  const logged = mock.method(process.stdout, "write", () => true);
  try {
    createPgDb("postgres://user:secret@localhost:1/db", createLogger());
    const handler = handlers["error"];
    assert.ok(handler, "pool.on('error') handler registered");
    handler(new Error("terminating connection"));
    assert.equal(logged.mock.callCount(), 1);
    const line = String(logged.mock.calls[0]?.arguments[0]);
    assert.ok(line.endsWith("\n"));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed["level"], "error");
    assert.equal(parsed["msg"], "db.pool_error");
    assert.equal(parsed["error"], "terminating connection");
    assert.ok(!line.includes("secret"));
  } finally {
    mock.restoreAll();
  }
});

test("client is destroyed when ROLLBACK fails", async () => {
  const releases: unknown[] = [];
  const client = {
    async query(sql: string) {
      if (sql === "ROLLBACK") throw new Error("connection dead");
      return { rows: [] };
    },
    release(arg?: unknown) {
      releases.push(arg);
    },
  };
  mock.method(pg.Pool.prototype, "connect", async () => client);
  try {
    const db = createPgDb("postgres://localhost:1/db");
    await assert.rejects(
      db.transaction(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual(releases, [true]);
  } finally {
    mock.restoreAll();
  }
});

test("client is returned to the pool when ROLLBACK succeeds", async () => {
  const releases: unknown[] = [];
  const client = {
    async query() {
      return { rows: [] };
    },
    release(arg?: unknown) {
      releases.push(arg);
    },
  };
  mock.method(pg.Pool.prototype, "connect", async () => client);
  try {
    const db = createPgDb("postgres://localhost:1/db");
    await assert.rejects(
      db.transaction(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual(releases, [false]);
  } finally {
    mock.restoreAll();
  }
});

test("pool errors are dropped when no logger is passed", () => {
  const handlers: Record<string, (err: Error) => void> = {};
  mock.method(pg.Pool.prototype, "on", (event: string, fn: (err: Error) => void) => {
    handlers[event] = fn;
  });
  const logged = mock.method(process.stdout, "write", () => true);
  try {
    createPgDb("postgres://localhost:1/db");
    handlers["error"]?.(new Error("terminating connection"));
    assert.equal(logged.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
  }
});

test("openDatabase accepts a pool-like object from another pg copy", async () => {
  let ended = 0;
  const pool = {
    async query() {
      return { rows: [{ one: 1 }] };
    },
    async connect() {
      return {
        async query() {
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {
      ended += 1;
    },
  };
  const { db, owned } = openDatabase(pool);
  assert.equal(owned, false);
  assert.deepEqual((await db.query("SELECT 1")).rows, [{ one: 1 }]);
  assert.equal(await db.transaction(async () => "done"), "done");
  await db.close();
  assert.equal(ended, 0);
});

test("openDatabase passes a Db through unowned", () => {
  const given = {
    query: async () => ({ rows: [] }),
    transaction: async <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never),
    close: async () => {},
  };
  const { db, owned } = openDatabase(given);
  assert.equal(db, given);
  assert.equal(owned, false);
});

test("openDatabase owns a connection string", async () => {
  const { db, owned } = openDatabase("postgres://127.0.0.1:1/none");
  assert.equal(owned, true);
  await db.close();
  // A live pool would reject with ECONNREFUSED; this message only comes from an ended pool.
  await assert.rejects(db.query("SELECT 1"), /after calling end/);
});
