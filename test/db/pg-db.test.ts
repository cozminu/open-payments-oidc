import { test, mock } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPgDb } from "../../src/db/db.ts";

test("pool error handler logs a single JSON line on stdout with the message only", () => {
  const handlers: Record<string, (err: Error) => void> = {};
  mock.method(pg.Pool.prototype, "on", (event: string, fn: (err: Error) => void) => {
    handlers[event] = fn;
  });
  const logged = mock.method(process.stdout, "write", () => true);
  try {
    createPgDb("postgres://user:secret@localhost:1/db");
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
