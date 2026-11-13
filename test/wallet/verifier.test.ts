import type { AuthenticatedClient } from "@interledger/open-payments";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PendingLoginRepo } from "../../src/db/pending-logins.ts";
import type { LogFields, Logger } from "../../src/log.ts";
import { AuthServerAllowlist } from "../../src/wallet/address.ts";
import { LoginHash } from "../../src/wallet/hash.ts";
import { WalletVerifier, type CallbackParams } from "../../src/wallet/verifier.ts";
import { createTestDb } from "../support/db.ts";
import {
  callbackParams,
  createFakeOpenPayments,
  createTestClient,
  FAKE_CONTINUE_TOKEN,
  FAKE_INTERACT_REF,
  type Fake,
  type FakeOptions,
} from "../support/fake-open-payments.ts";

const CALLBACK = "https://oidc.example/interaction/uid-1/callback";

type LogCall = { level: "info" | "warn" | "error"; msg: string; fields?: LogFields };

function recordingLogger(): { log: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const record = (level: LogCall["level"]) => (msg: string, fields?: LogFields) => {
    calls.push(fields === undefined ? { level, msg } : { level, msg, fields });
  };
  return {
    calls,
    log: { info: record("info"), warn: record("warn"), error: record("error") },
  };
}

async function setup(
  context: TestContext,
  fakeOptions: FakeOptions = {},
  overrides: { allowlist?: string[]; checkHost?: (url: string) => Promise<void> } = {},
) {
  const fake = await createFakeOpenPayments(context, fakeOptions);
  const db = await createTestDb();
  context.after(() => db.close());
  const logger = recordingLogger();
  const verifier = new WalletVerifier({
    client: await createTestClient(context),
    pendingLogins: new PendingLoginRepo(db),
    allowlist: new AuthServerAllowlist(overrides.allowlist ?? [fake.url]),
    allowHttp: true,
    createNonce: () => "client-nonce",
    log: logger.log,
    ...(overrides.checkHost === undefined ? {} : { checkHost: overrides.checkHost }),
  });
  return { fake, verifier, calls: logger.calls };
}

async function startAndInteract(
  verifier: WalletVerifier,
  fake: Fake,
  uid = "uid-1",
): Promise<CallbackParams> {
  const started = await verifier.start(uid, fake.walletAddress, CALLBACK);
  assert.equal(started.kind, "redirect");
  if (started.kind !== "redirect") throw new Error("unreachable");
  return callbackParams(await fake.interact(started.redirectUrl));
}

test("start sends a subject-only grant", async (context) => {
  const { fake, verifier } = await setup(context);
  const outcome = await verifier.start("uid-1", fake.walletAddress, CALLBACK);
  assert.equal(outcome.kind, "redirect");
  assert.equal(fake.grantRequests.length, 1);
  const grant = fake.grantRequests[0] as Record<string, any>;
  assert.deepEqual(grant.subject, { sub_ids: [{ id: `${fake.url}/alice`, format: "uri" }] });
  assert.equal("access_token" in grant, false);
  assert.equal(grant.interact.finish.uri, CALLBACK);
  assert.equal(grant.interact.finish.nonce, "client-nonce");
  assert.deepEqual(grant.interact.start, ["redirect"]);
});

test("start rejects an unparseable address", async (context) => {
  const { verifier, fake } = await setup(context);
  const outcome = await verifier.start("uid-1", "not a url", CALLBACK);
  assert.equal(outcome.kind, "invalid_input");
  assert.equal(fake.walletRequests.length, 0);
});

test("start rejects an unsupported auth server", async (context) => {
  const other = await createFakeOpenPayments(context);
  const { fake, verifier } = await setup(context, { authServerOverride: `${other.url}/auth` });
  const outcome = await verifier.start("uid-1", fake.walletAddress, CALLBACK);
  assert.equal(outcome.kind, "invalid_input");
  if (outcome.kind !== "invalid_input") throw new Error("unreachable");
  assert.match(outcome.message, /isn't supported yet/);
  assert.ok(outcome.message.includes(other.url));
  assert.equal(fake.grantRequests.length, 0);
  assert.equal(other.grantRequests.length, 0);
});

test("start rejects an unsupported auth server given as 127.0.0.1 on another port", async (context) => {
  const { fake, verifier } = await setup(context, {
    authServerOverride: "http://127.0.0.1:1/auth",
  });
  const outcome = await verifier.start("uid-1", fake.walletAddress, CALLBACK);
  assert.equal(outcome.kind, "invalid_input");
  if (outcome.kind !== "invalid_input") throw new Error("unreachable");
  assert.match(outcome.message, /isn't supported yet/);
  assert.ok(outcome.message.includes("http://127.0.0.1:1"));
  assert.equal(fake.grantRequests.length, 0);
});

test("start rejects an http wallet address unless allowHttp", async (context) => {
  const fake = await createFakeOpenPayments(context);
  const db = await createTestDb();
  context.after(() => db.close());
  const verifier = new WalletVerifier({
    client: await createTestClient(context),
    pendingLogins: new PendingLoginRepo(db),
    allowlist: new AuthServerAllowlist([fake.url]),
    allowHttp: false,
    checkHost: async () => {},
    log: recordingLogger().log,
  });
  // The wallet address is http too, so allowHttp=false refuses it before any request is made.
  const outcome = await verifier.start("uid-1", fake.walletAddress, CALLBACK);
  assert.equal(outcome.kind, "invalid_input");
  assert.equal(fake.walletRequests.length, 0);
  assert.equal(fake.grantRequests.length, 0);
});

test("start rejects an http auth server when allowHttp is false even if the wallet is https", async (context) => {
  const fake = await createFakeOpenPayments(context);
  const db = await createTestDb();
  context.after(() => db.close());
  // Stub client: the wallet address is served over "https" with an http auth server on the allowlist.
  let grantCalls = 0;
  const client = {
    walletAddress: {
      get: async () => ({
        id: "https://wallet.example/alice",
        authServer: `${fake.url}/auth`,
      }),
    },
    grant: {
      request: async () => {
        grantCalls += 1;
        throw new Error("must not be called");
      },
    },
  } as unknown as AuthenticatedClient;
  const verifier = new WalletVerifier({
    client,
    pendingLogins: new PendingLoginRepo(db),
    allowlist: new AuthServerAllowlist([fake.url]),
    allowHttp: false,
    checkHost: async () => {},
    log: recordingLogger().log,
  });
  const outcome = await verifier.start("uid-1", "https://wallet.example/alice", CALLBACK);
  assert.equal(outcome.kind, "invalid_input");
  assert.equal(grantCalls, 0);
});

test("start rejects a non-public host without fetching the wallet address", async (context) => {
  const { fake, verifier } = await setup(
    context,
    {},
    {
      checkHost: async () => {
        throw new Error("loopback");
      },
    },
  );
  const outcome = await verifier.start("uid-1", fake.walletAddress, CALLBACK);
  assert.equal(outcome.kind, "invalid_input");
  assert.equal(fake.walletRequests.length, 0);
});

test("start calls an injected checkHost with the normalized wallet address url", async (context) => {
  const seen: string[] = [];
  const { fake, verifier } = await setup(
    context,
    {},
    {
      checkHost: async (url) => {
        seen.push(url);
      },
    },
  );
  await verifier.start("uid-1", ` ${fake.walletAddress} `, CALLBACK);
  assert.deepEqual(seen, [fake.walletAddress]);
});

test("start reports a wallet address that cannot be fetched as invalid input", async (context) => {
  const { fake, verifier } = await setup(context);
  const outcome = await verifier.start("uid-1", `${fake.url}/nobody`, CALLBACK);
  assert.equal(outcome.kind, "invalid_input");
});

test("start returns failed instead of throwing when the grant request fails", async (context) => {
  const { fake, verifier } = await setup(
    context,
    { authServerOverride: "http://127.0.0.1:1/auth" },
    { allowlist: ["http://127.0.0.1:1"] },
  );
  const outcome = await verifier.start("uid-1", fake.walletAddress, CALLBACK);
  assert.equal(outcome.kind, "failed");
});

test("wallet on any host works as long as its auth server is allowlisted", async (context) => {
  const authFake = await createFakeOpenPayments(context);
  const walletFake = await createFakeOpenPayments(context, {
    authServerOverride: authFake.authServer,
  });
  assert.notEqual(authFake.url, walletFake.url);
  const { verifier } = await setup(context, {}, { allowlist: [authFake.url] });
  const outcome = await verifier.start("uid-1", walletFake.walletAddress, CALLBACK);
  assert.equal(outcome.kind, "redirect");
  assert.equal(walletFake.walletRequests.length, 1);
  assert.equal(authFake.grantRequests.length, 1);
});

test("finish verifies and returns the canonical wallet address", async (context) => {
  const { fake, verifier } = await setup(context);
  const params = await startAndInteract(verifier, fake);
  const outcome = await verifier.finish("uid-1", params);
  assert.deepEqual(outcome, { kind: "verified", walletAddress: `${fake.url}/alice` });
  assert.equal(fake.continueRequests.length, 1);
  assert.equal(fake.continueRequests[0]?.authorization, `GNAP ${FAKE_CONTINUE_TOKEN}`);
  assert.deepEqual(fake.continueRequests[0]?.body, { interact_ref: FAKE_INTERACT_REF });
});

test("finish is denied when the wallet rejects", async (context) => {
  const { fake, verifier } = await setup(context, { approval: "reject" });
  const params = await startAndInteract(verifier, fake);
  assert.equal(params.result, "grant_rejected");
  const outcome = await verifier.finish("uid-1", params);
  assert.equal(outcome.kind, "denied");
  assert.equal(fake.continueRequests.length, 0);
});

test("finish fails on a bad hash without continuing the grant", async (context) => {
  const { fake, verifier } = await setup(context, { approval: "tamper" });
  const params = await startAndInteract(verifier, fake);
  const outcome = await verifier.finish("uid-1", params);
  assert.equal(outcome.kind, "failed");
  assert.equal(fake.continueRequests.length, 0);
});

test("finish fails when the redirect has no interact_ref or hash", async (context) => {
  const { fake, verifier } = await setup(context);
  await startAndInteract(verifier, fake);
  const outcome = await verifier.finish("uid-1", {});
  assert.equal(outcome.kind, "failed");
  assert.equal(fake.continueRequests.length, 0);
});

test("finish fails when the verified subject is a different wallet address", async (context) => {
  const { fake, verifier } = await setup(context, { verifiedPath: "/bob" });
  const params = await startAndInteract(verifier, fake);
  const outcome = await verifier.finish("uid-1", params);
  assert.equal(outcome.kind, "failed");
});

test("finish fails for an unknown uid", async (context) => {
  const { verifier } = await setup(context);
  const outcome = await verifier.finish("nope", { interactRef: "a", hash: "b" });
  assert.equal(outcome.kind, "failed");
});

test("finish twice: the second call fails as expired or already used", async (context) => {
  const { fake, verifier } = await setup(context);
  const params = await startAndInteract(verifier, fake);
  assert.equal((await verifier.finish("uid-1", params)).kind, "verified");
  const second = await verifier.finish("uid-1", params);
  assert.equal(second.kind, "failed");
  if (second.kind !== "failed") throw new Error("unreachable");
  assert.match(second.reason, /expired or already used/);
});

test("finish revokes a returned access token", async (context) => {
  const { fake, verifier } = await setup(context, { returnAccessToken: true });
  const params = await startAndInteract(verifier, fake);
  const outcome = await verifier.finish("uid-1", params);
  assert.equal(outcome.kind, "verified");
  assert.equal(fake.revokeRequests.length, 1);
  assert.equal(fake.revokeRequests[0]?.authorization, "GNAP issued-token");
});

test("finish revokes a returned access token even when the subject is wrong", async (context) => {
  const { fake, verifier } = await setup(context, {
    returnAccessToken: true,
    verifiedPath: "/bob",
  });
  const params = await startAndInteract(verifier, fake);
  assert.equal((await verifier.finish("uid-1", params)).kind, "failed");
  assert.equal(fake.revokeRequests.length, 1);
});

test("finish does not revoke when no access token is returned", async (context) => {
  const { fake, verifier } = await setup(context);
  const params = await startAndInteract(verifier, fake);
  await verifier.finish("uid-1", params);
  assert.equal(fake.revokeRequests.length, 0);
});

test("finish tolerates a revoke failure and logs one warning without secrets", async (context) => {
  const { fake, verifier, calls } = await setup(context, {
    returnAccessToken: true,
    revokeFails: true,
  });
  const params = await startAndInteract(verifier, fake);
  const outcome = await verifier.finish("uid-1", params);
  assert.equal(outcome.kind, "verified");
  assert.equal(fake.revokeRequests.length, 1);
  assert.equal(calls.filter((call) => call.level === "warn").length, 1);
  const logged = JSON.stringify(calls);
  for (const secret of [FAKE_CONTINUE_TOKEN, FAKE_INTERACT_REF, "issued-token", "next-token"]) {
    assert.equal(logged.includes(secret), false, `log leaked ${secret}`);
  }
  assert.equal(logged.includes(params.hash ?? "missing"), false);
  assert.equal(logged.includes(`${fake.url}/alice`), false, "full wallet address was logged");
});

test("logs never contain secrets on failure paths either", async (context) => {
  const { fake, verifier, calls } = await setup(context, { approval: "tamper" });
  const params = await startAndInteract(verifier, fake);
  await verifier.finish("uid-1", params);
  const logged = JSON.stringify(calls);
  for (const secret of [FAKE_CONTINUE_TOKEN, FAKE_INTERACT_REF, params.hash ?? "missing"]) {
    assert.equal(logged.includes(secret), false, `log leaked ${secret}`);
  }
});

test("start logs login.start with wallet host, auth server origin and outcome", async (context) => {
  const { fake, verifier, calls } = await setup(context);
  await verifier.start("uid-1", fake.walletAddress, CALLBACK);
  assert.deepEqual(calls, [
    {
      level: "info",
      msg: "login.start",
      fields: {
        walletHost: new URL(fake.url).host,
        authServerOrigin: new URL(`${fake.url}/auth`).origin,
        outcome: "redirect",
      },
    },
  ]);
});

test("start logs invalid input with a reason", async (context) => {
  const { fake, verifier, calls } = await setup(context, {
    authServerOverride: "http://127.0.0.1:1/auth",
  });
  await verifier.start("uid-1", fake.walletAddress, CALLBACK);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.msg, "login.start");
  assert.equal(calls[0]?.fields?.["outcome"], "invalid_input");
  assert.equal(typeof calls[0]?.fields?.["reason"], "string");
  assert.equal(calls[0]?.fields?.["walletHost"], new URL(fake.url).host);
});

test("finish logs login.finish verified with the wallet host", async (context) => {
  const { fake, verifier, calls } = await setup(context);
  const params = await startAndInteract(verifier, fake);
  calls.length = 0;
  await verifier.finish("uid-1", params);
  assert.deepEqual(calls, [
    {
      level: "info",
      msg: "login.finish",
      fields: { walletHost: new URL(fake.url).host, outcome: "verified" },
    },
  ]);
});

test("finish logs a failure reason as a warning", async (context) => {
  const { fake, verifier, calls } = await setup(context, { approval: "tamper" });
  const params = await startAndInteract(verifier, fake);
  calls.length = 0;
  await verifier.finish("uid-1", params);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.level, "warn");
  assert.equal(calls[0]?.msg, "login.finish");
  assert.equal(calls[0]?.fields?.["outcome"], "failed");
  assert.equal(calls[0]?.fields?.["walletHost"], new URL(fake.url).host);
  assert.equal(typeof calls[0]?.fields?.["reason"], "string");
});

test("finish for an unknown login logs without a wallet host", async (context) => {
  const { verifier, calls } = await setup(context);
  await verifier.finish("missing", { interactRef: "r", hash: "h" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.msg, "login.finish");
  assert.equal(calls[0]?.fields?.["outcome"], "failed");
  assert.equal("walletHost" in (calls[0]?.fields ?? {}), false);
});

test("a revoke failure logs token.revoke_failed", async (context) => {
  const { fake, verifier, calls } = await setup(context, {
    returnAccessToken: true,
    revokeFails: true,
  });
  const params = await startAndInteract(verifier, fake);
  await verifier.finish("uid-1", params);
  const entry = calls.find((call) => call.msg === "token.revoke_failed");
  assert.equal(entry?.level, "warn");
  assert.equal(entry?.fields?.["walletHost"], new URL(fake.url).host);
});

// A client that serves an https wallet and auth server, for the paths that need allowHttp=false.
async function strictVerifier(context: TestContext, grant: unknown, continued?: unknown) {
  const db = await createTestDb();
  context.after(() => db.close());
  const logger = recordingLogger();
  const client = {
    walletAddress: {
      get: async () => ({
        id: "https://wallet.example/alice",
        authServer: "https://auth.example/tenant",
      }),
    },
    grant: { request: async () => grant, continue: async () => continued },
  } as unknown as AuthenticatedClient;
  const verifier = new WalletVerifier({
    client,
    pendingLogins: new PendingLoginRepo(db),
    allowlist: new AuthServerAllowlist(["https://auth.example"]),
    allowHttp: false,
    checkHost: async () => {},
    createNonce: () => "client-nonce",
    log: logger.log,
  });
  return { verifier, calls: logger.calls };
}

function pendingGrant(overrides: { redirect?: string; continueUri?: string } = {}) {
  return {
    interact: { redirect: overrides.redirect ?? "https://auth.example/interact/1", finish: "n" },
    continue: {
      access_token: { value: "t" },
      uri: overrides.continueUri ?? "https://auth.example/continue/1",
    },
  };
}

// The SDK validates continuation responses against a spec that only knows format "uri", so a
// different format can't come through the fake server; a stub client reaches the predicate.
test("finish fails when the subject has the right id but a different format", async (context) => {
  const hash = LoginHash.compute({
    clientNonce: "client-nonce",
    interactNonce: "n",
    interactRef: "r",
    authServerUrl: "https://auth.example/tenant",
  });
  const continued = (format: string) => ({
    subject: { sub_ids: [{ id: "https://wallet.example/alice", format }] },
    continue: { access_token: { value: "t" }, uri: "https://auth.example/continue/1" },
  });
  const outcomes = [];
  const reasons = [];
  for (const format of ["uri", "opaque"]) {
    const { verifier, calls } = await strictVerifier(context, pendingGrant(), continued(format));
    await verifier.start("uid-1", "https://wallet.example/alice", CALLBACK);
    outcomes.push((await verifier.finish("uid-1", { interactRef: "r", hash })).kind);
    reasons.push(calls.at(-1)?.fields?.["reason"]);
  }
  // "uri" proves the stub reaches the subject check; only the format differs for "opaque".
  assert.deepEqual(outcomes, ["verified", "failed"]);
  assert.equal(reasons[1], "continuation subject mismatch");
});

test("start accepts an https interact redirect when allowHttp is false", async (context) => {
  const { verifier } = await strictVerifier(context, pendingGrant());
  const outcome = await verifier.start("uid-1", "https://wallet.example/alice", CALLBACK);
  assert.deepEqual(outcome, { kind: "redirect", redirectUrl: "https://auth.example/interact/1" });
});

test("start fails on a non-https interact redirect when allowHttp is false", async (context) => {
  for (const redirect of ["http://auth.example/interact/1", "javascript:alert(1)", "not a url"]) {
    const { verifier, calls } = await strictVerifier(context, pendingGrant({ redirect }));
    const outcome = await verifier.start("uid-1", "https://wallet.example/alice", CALLBACK);
    assert.equal(outcome.kind, "failed", redirect);
    assert.equal(calls.at(-1)?.fields?.["reason"], "interact redirect not allowed");
    // Nothing was saved, so there is nothing to finish.
    assert.equal((await verifier.finish("uid-1", { interactRef: "r", hash: "h" })).kind, "failed");
    assert.equal(calls.at(-1)?.fields?.["reason"], "no pending login");
  }
});

test("start fails when continue.uri is outside the allowlist", async (context) => {
  const other = await createFakeOpenPayments(context);
  const { fake, verifier, calls } = await setup(context, {
    continueUriOverride: `${other.url}/auth/continue/1`,
  });
  const outcome = await verifier.start("uid-1", fake.walletAddress, CALLBACK);
  assert.equal(outcome.kind, "failed");
  assert.equal(calls.at(-1)?.fields?.["reason"], "continue url not allowed");
  assert.equal((await verifier.finish("uid-1", { interactRef: "r", hash: "h" })).kind, "failed");
  assert.equal(other.continueRequests.length, 0);
});

test("finish fails and sends no token when access_token.manage is outside the allowlist", async (context) => {
  const other = await createFakeOpenPayments(context);
  const { fake, verifier, calls } = await setup(context, {
    returnAccessToken: true,
    manageUrlOverride: `${other.url}/auth/token/1`,
  });
  const params = await startAndInteract(verifier, fake);
  const outcome = await verifier.finish("uid-1", params);
  assert.equal(outcome.kind, "failed");
  assert.equal(calls.at(-1)?.fields?.["reason"], "token manage url not allowed");
  assert.equal(other.revokeRequests.length, 0);
  assert.equal(fake.revokeRequests.length, 0);
});

test("with allowHttp false and no checkHost injected, a loopback wallet host is refused", async (context) => {
  const fake = await createFakeOpenPayments(context);
  const db = await createTestDb();
  context.after(() => db.close());
  const logger = recordingLogger();
  let clientCalls = 0;
  const client = {
    walletAddress: {
      get: async () => {
        clientCalls += 1;
        throw new Error("must not be called");
      },
    },
  } as unknown as AuthenticatedClient;
  const verifier = new WalletVerifier({
    client,
    pendingLogins: new PendingLoginRepo(db),
    allowlist: new AuthServerAllowlist([fake.url]),
    allowHttp: false,
    log: logger.log,
  });
  const port = new URL(fake.url).port;
  const outcome = await verifier.start("uid-1", `https://127.0.0.1:${port}/alice`, CALLBACK);
  assert.equal(outcome.kind, "invalid_input");
  assert.equal(logger.calls.at(-1)?.fields?.["reason"], "wallet host refused");
  assert.equal(clientCalls, 0);
  assert.equal(fake.walletRequests.length, 0);
});
