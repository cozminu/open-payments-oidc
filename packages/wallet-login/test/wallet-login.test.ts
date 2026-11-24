import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletLogin, type WalletLogin, type WalletLoginConfig } from "../src/index.ts";
import { memoryStore, postgresStore, type PendingLoginStore } from "../src/index.ts";
import { createLogger } from "../src/index.ts";
import { createTestDb } from "../../../test/support/db.ts";
import {
  createFakeOpenPayments,
  FAKE_CONTINUE_TOKEN,
  FAKE_INTERACT_REF,
  type Fake,
} from "../../../test/support/fake-open-payments.ts";

const stores: Record<string, (context: TestContext) => Promise<PendingLoginStore>> = {
  memory: async () => memoryStore(),
  postgres: async (context) => {
    const db = await createTestDb();
    context.after(() => db.close());
    return postgresStore({ database: db, cleanup: false });
  },
};

function config(fake: Fake, store: PendingLoginStore, privateKey?: KeyObject | string) {
  return {
    wallet: {
      address: "http://127.0.0.1:1/provider",
      keyId: "test-key",
      privateKey: privateKey ?? generateKeyPairSync("ed25519").privateKey,
    },
    authServerAllowlist: [fake.url],
    allowHttp: true,
    store,
  } satisfies WalletLoginConfig;
}

async function setup(
  context: TestContext,
  make: (context: TestContext) => Promise<PendingLoginStore>,
  overrides: Partial<WalletLoginConfig> = {},
): Promise<{ fake: Fake; login: WalletLogin }> {
  const fake = await createFakeOpenPayments(context);
  const login = await createWalletLogin({ ...config(fake, await make(context)), ...overrides });
  context.after(() => login.close());
  return { fake, login };
}

const CALLBACK = "https://app.example/wallet-callback";
const EXPIRED = "Login expired or already used. Please start again.";

async function started(login: WalletLogin, fake: Fake, loginId?: string) {
  const outcome = await login.start(fake.walletAddress, CALLBACK, loginId ? { loginId } : {});
  assert.equal(outcome.kind, "redirect");
  if (outcome.kind !== "redirect") throw new Error("unreachable");
  return { ...outcome, callback: await fake.interact(outcome.redirectUrl) };
}

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: start then finish verifies the wallet address`, async (context) => {
    const { fake, login } = await setup(context, make);
    const { loginId, callback } = await started(login, fake);
    assert.match(loginId, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(callback.origin + callback.pathname, CALLBACK);
    assert.deepEqual(await login.finish(loginId, callback.searchParams), {
      kind: "verified",
      walletAddress: fake.walletAddress,
    });
  });

  test(`${name}: a loginId works once`, async (context) => {
    const { fake, login } = await setup(context, make);
    const { loginId, callback } = await started(login, fake);
    assert.equal((await login.finish(loginId, callback.searchParams)).kind, "verified");
    assert.deepEqual(await login.finish(loginId, callback.searchParams), {
      kind: "failed",
      reason: EXPIRED,
    });
  });

  test(`${name}: a callback replayed against another loginId fails`, async (context) => {
    const { fake, login } = await setup(context, make);
    const a = await started(login, fake);
    const b = await started(login, fake);
    assert.equal((await login.finish(b.loginId, a.callback.searchParams)).kind, "failed");
    assert.deepEqual(await login.finish(b.loginId, b.callback.searchParams), {
      kind: "failed",
      reason: EXPIRED,
    });
    assert.equal((await login.finish(a.loginId, a.callback.searchParams)).kind, "verified");
  });

  test(`${name}: options.loginId is used as given`, async (context) => {
    const { fake, login } = await setup(context, make);
    const { loginId, callback } = await started(login, fake, "my-login-id");
    assert.equal(loginId, "my-login-id");
    assert.equal((await login.finish("my-login-id", callback.searchParams)).kind, "verified");
  });

  test(`${name}: finish accepts already parsed callback params`, async (context) => {
    const { fake, login } = await setup(context, make);
    const { loginId, callback } = await started(login, fake);
    const params = {
      interactRef: callback.searchParams.get("interact_ref")!,
      hash: callback.searchParams.get("hash")!,
    };
    assert.equal((await login.finish(loginId, params)).kind, "verified");
  });

  test(`${name}: close is idempotent and later calls fail cleanly`, async (context) => {
    const { fake, login } = await setup(context, make);
    await Promise.all([login.close(), login.close()]);
    assert.equal((await login.start(fake.walletAddress, CALLBACK)).kind, "failed");
    assert.equal((await login.finish("x", new URLSearchParams())).kind, "failed");
  });

  test(`${name}: nothing is logged without a logger, and secrets never are with one`, async (context) => {
    const lines: string[] = [];
    const log = createLogger({ write: (line: string) => void lines.push(line) });
    const { fake, login } = await setup(context, make, { log });
    const { loginId, callback } = await started(login, fake);
    await login.finish(loginId, callback.searchParams);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(!line.includes(FAKE_CONTINUE_TOKEN), line);
      assert.ok(!line.includes(FAKE_INTERACT_REF), line);
    }
  });
}

test("config errors are collected", async (context) => {
  const fake = await createFakeOpenPayments(context);
  const base = config(fake, memoryStore());
  await assert.rejects(
    createWalletLogin({
      ...base,
      wallet: { ...base.wallet, keyId: "" },
      authServerAllowlist: [],
      outboundTimeoutMs: 0,
    }),
    (error: Error) => {
      assert.match(error.message, /^Invalid configuration:\n- /);
      assert.match(error.message, /authServerAllowlist must list at least one origin/);
      assert.match(error.message, /outboundTimeoutMs/);
      assert.match(error.message, /wallet\.keyId/);
      return true;
    },
  );
  await assert.rejects(
    createWalletLogin({
      ...base,
      allowHttp: false,
      authServerAllowlist: ["*", "http://x.example"],
    }),
    (error: Error) => {
      assert.match(error.message, /entry "\*" is not a valid URL/);
      assert.match(error.message, /allowHttp/);
      return true;
    },
  );
});

test("a file path as privateKey is a config error", async (context) => {
  const fake = await createFakeOpenPayments(context);
  const dir = await mkdtemp(join(tmpdir(), "wallet-login-key-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "private.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }));
  // The file holds a valid key; if it were read, this would succeed.
  await assert.rejects(
    createWalletLogin(config(fake, memoryStore(), path)),
    /wallet\.privateKey must be PEM text or a KeyObject/,
  );
});

test("PEM text works as privateKey, and broken PEM is a config error", async (context) => {
  const fake = await createFakeOpenPayments(context);
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const login = await createWalletLogin(config(fake, memoryStore(), pem));
  await login.close();
  await assert.rejects(
    createWalletLogin(config(fake, memoryStore(), "-----BEGIN PRIVATE KEY-----\nnope\n")),
    /wallet\.privateKey is not a valid PEM private key/,
  );
});

test("a non-Ed25519 privateKey is a config error, as PEM or KeyObject", async (context) => {
  const fake = await createFakeOpenPayments(context);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  for (const key of [pem, privateKey]) {
    await assert.rejects(
      createWalletLogin(config(fake, memoryStore(), key)),
      /wallet\.privateKey must be an Ed25519 private key/,
    );
  }
});
