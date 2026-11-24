import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PendingLoginRepo } from "../src/pending-logins.ts";
import type { LogFields, Logger } from "../src/log.ts";
import type {
  GrantContinuation,
  GrantStart,
  WalletAddressLookup,
} from "../src/open-payments-gateway.ts";
import { WalletVerifier, type CallbackParams } from "../src/verifier.ts";
import { createTestDb } from "../../../test/support/db.ts";
import { interactionHash } from "../../../test/support/fake-open-payments.ts";
import {
  AUTH_SERVER,
  CONTINUE_TOKEN,
  CONTINUE_URL,
  INTERACT_NONCE,
  INTERACT_REDIRECT,
  InMemoryGateway,
  WALLET_ADDRESS,
  type InMemoryGatewayOptions,
} from "../../../test/support/in-memory-gateway.ts";

const CALLBACK = "https://oidc.example/interaction/uid-1/callback";
const NONCE = "client-nonce";
const INTERACT_REF = "interact-ref";
const WALLET_HOST = "wallet.example";

// What a real auth server would put in the finish redirect for the default grant.
const APPROVED: CallbackParams = {
  interactRef: INTERACT_REF,
  hash: interactionHash(NONCE, INTERACT_NONCE, INTERACT_REF, AUTH_SERVER),
};

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

async function setup(context: TestContext, options: InMemoryGatewayOptions = {}) {
  const db = await createTestDb();
  context.after(() => db.close());
  const logger = recordingLogger();
  const gateway = new InMemoryGateway(options);
  const verifier = new WalletVerifier({
    gateway,
    pendingLogins: new PendingLoginRepo(db),
    createNonce: () => NONCE,
    log: logger.log,
  });
  return { gateway, verifier, calls: logger.calls };
}

/** Starts a login and returns the verifier, ready for finish. */
async function started(context: TestContext, options: InMemoryGatewayOptions = {}) {
  const setUp = await setup(context, options);
  const outcome = await setUp.verifier.start("uid-1", WALLET_ADDRESS, CALLBACK);
  assert.equal(outcome.kind, "redirect");
  setUp.calls.length = 0;
  return setUp;
}

test("start asks for a grant for the wallet address and sends the user to the auth server", async (context) => {
  const { gateway, verifier } = await setup(context);
  const outcome = await verifier.start("uid-1", " $wallet.example/alice ", CALLBACK);
  assert.deepEqual(outcome, { kind: "redirect", redirectUrl: INTERACT_REDIRECT });
  assert.deepEqual(gateway.lookups, [" $wallet.example/alice "]);
  assert.deepEqual(gateway.grantRequests, [
    {
      walletAddressId: WALLET_ADDRESS,
      authServer: AUTH_SERVER,
      callbackUrl: CALLBACK,
      nonce: NONCE,
    },
  ]);
});

test("start maps each wallet address lookup failure to invalid input and asks for no grant", async (context) => {
  const url = "https://wallet.example/alice";
  const cases: [WalletAddressLookup, string, RegExp][] = [
    [{ kind: "unparseable" }, "unparseable address", /doesn't look like a wallet address/],
    [
      { kind: "host_refused", walletAddressUrl: url, error: "e" },
      "wallet host refused",
      /couldn't reach/,
    ],
    [
      { kind: "not_found", walletAddressUrl: url, error: "e" },
      "wallet address fetch failed",
      /couldn't find/,
    ],
    [
      { kind: "invalid_auth_server", walletAddressUrl: url },
      "invalid auth server",
      /invalid auth server/,
    ],
    [
      {
        kind: "auth_server_not_allowed",
        walletAddressUrl: url,
        authServer: "https://other.example/auth",
      },
      "auth server not supported",
      /isn't supported yet \(auth server https:\/\/other\.example\)/,
    ],
  ];
  for (const [lookup, reason, message] of cases) {
    const { gateway, verifier, calls } = await setup(context, { lookup });
    const outcome = await verifier.start("uid-1", url, CALLBACK);
    assert.equal(outcome.kind, "invalid_input", lookup.kind);
    if (outcome.kind !== "invalid_input") throw new Error("unreachable");
    assert.match(outcome.message, message);
    assert.equal(calls.at(-1)?.fields?.["reason"], reason);
    assert.equal(gateway.grantRequests.length, 0);
  }
});

test("start maps each grant failure and saves nothing to finish", async (context) => {
  const cases: [GrantStart, string, string][] = [
    [{ kind: "auth_server_not_allowed" }, "auth server not supported", "invalid_input"],
    [{ kind: "rejected", error: "e" }, "grant request failed", "failed"],
    [{ kind: "not_interactive" }, "grant did not ask for interaction", "failed"],
    [{ kind: "continue_url_not_allowed" }, "continue url not allowed", "failed"],
    [{ kind: "interact_redirect_not_allowed" }, "interact redirect not allowed", "failed"],
  ];
  for (const [grant, reason, kind] of cases) {
    const { gateway, verifier, calls } = await setup(context, { grant });
    const outcome = await verifier.start("uid-1", WALLET_ADDRESS, CALLBACK);
    assert.equal(outcome.kind, kind, grant.kind);
    assert.equal(calls.at(-1)?.fields?.["reason"], reason);
    assert.equal((await verifier.finish("uid-1", APPROVED)).kind, "failed");
    assert.equal(calls.at(-1)?.fields?.["reason"], "no pending login");
    assert.equal(gateway.continuations.length, 0);
  }
});

test("finish continues the grant and returns the wallet address", async (context) => {
  const { gateway, verifier } = await started(context);
  const outcome = await verifier.finish("uid-1", APPROVED);
  assert.deepEqual(outcome, { kind: "verified", walletAddress: WALLET_ADDRESS });
  assert.deepEqual(gateway.continuations, [
    { continueUrl: CONTINUE_URL, continueAccessToken: CONTINUE_TOKEN, interactRef: INTERACT_REF },
  ]);
});

test("finish verifies the wallet address's id, not what the user typed", async (context) => {
  const id = "https://wallet.example/alice-canonical";
  const { verifier } = await started(context, {
    lookup: {
      kind: "found",
      walletAddressUrl: "https://pointer.example/alice",
      walletAddressId: id,
      authServer: AUTH_SERVER,
    },
    continuation: { kind: "continued", subjectIds: [id] },
  });
  assert.deepEqual(await verifier.finish("uid-1", APPROVED), {
    kind: "verified",
    walletAddress: id,
  });
});

test("finish is denied when the wallet rejects", async (context) => {
  const { gateway, verifier } = await started(context);
  const outcome = await verifier.finish("uid-1", { result: "grant_rejected" });
  assert.equal(outcome.kind, "denied");
  assert.equal(gateway.continuations.length, 0);
});

test("finish fails on a bad hash without continuing the grant", async (context) => {
  const { gateway, verifier, calls } = await started(context);
  const outcome = await verifier.finish("uid-1", { ...APPROVED, hash: `x${APPROVED.hash}` });
  assert.equal(outcome.kind, "failed");
  assert.equal(calls.at(-1)?.fields?.["reason"], "hash mismatch");
  assert.equal(gateway.continuations.length, 0);
});

test("finish fails when the redirect has no interact_ref or hash", async (context) => {
  const { gateway, verifier } = await started(context);
  const outcome = await verifier.finish("uid-1", {});
  assert.equal(outcome.kind, "failed");
  assert.equal(gateway.continuations.length, 0);
});

test("finish fails unless the auth server verified exactly this wallet address", async (context) => {
  const cases: [readonly string[] | undefined, string][] = [
    [["https://wallet.example/bob"], "continuation subject mismatch"],
    [[], "continuation subject mismatch"],
    [undefined, "continuation had no subject"],
  ];
  for (const [subjectIds, reason] of cases) {
    const { verifier, calls } = await started(context, {
      continuation: { kind: "continued", subjectIds },
    });
    const outcome = await verifier.finish("uid-1", APPROVED);
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    assert.match(outcome.reason, /didn't confirm the wallet address/);
    assert.equal(calls.at(-1)?.fields?.["reason"], reason);
  }
});

test("finish maps each continuation failure to failed", async (context) => {
  const cases: [GrantContinuation, string][] = [
    [{ kind: "continue_url_not_allowed" }, "continue url not allowed"],
    [{ kind: "rejected", error: "e" }, "grant continuation failed"],
    [{ kind: "manage_url_not_allowed" }, "token manage url not allowed"],
  ];
  for (const [continuation, reason] of cases) {
    const { verifier, calls } = await started(context, { continuation });
    assert.equal((await verifier.finish("uid-1", APPROVED)).kind, "failed", continuation.kind);
    assert.equal(calls.at(-1)?.fields?.["reason"], reason);
  }
});

test("finish fails for an unknown uid", async (context) => {
  const { verifier } = await setup(context);
  const outcome = await verifier.finish("nope", { interactRef: "a", hash: "b" });
  assert.equal(outcome.kind, "failed");
});

test("finish twice: the second call fails as expired or already used", async (context) => {
  const { gateway, verifier } = await started(context);
  assert.equal((await verifier.finish("uid-1", APPROVED)).kind, "verified");
  const second = await verifier.finish("uid-1", APPROVED);
  assert.equal(second.kind, "failed");
  if (second.kind !== "failed") throw new Error("unreachable");
  assert.match(second.reason, /expired or already used/);
  assert.equal(gateway.continuations.length, 1);
});

test("a revoke failure logs token.revoke_failed and the login still verifies", async (context) => {
  const { verifier, calls } = await started(context, {
    continuation: { kind: "continued", subjectIds: [WALLET_ADDRESS], revokeError: "forbidden" },
  });
  const outcome = await verifier.finish("uid-1", APPROVED);
  assert.equal(outcome.kind, "verified");
  assert.deepEqual(calls[0], {
    level: "warn",
    msg: "token.revoke_failed",
    fields: { walletHost: WALLET_HOST, error: "forbidden" },
  });
  assert.equal(calls.filter((call) => call.level === "warn").length, 1);
});

test("a revoke failure is logged even when the subject is wrong", async (context) => {
  const { verifier, calls } = await started(context, {
    continuation: { kind: "continued", subjectIds: [], revokeError: "forbidden" },
  });
  assert.equal((await verifier.finish("uid-1", APPROVED)).kind, "failed");
  assert.equal(calls[0]?.msg, "token.revoke_failed");
});

test("start and finish never throw, even when the gateway breaks its contract", async (context) => {
  const db = await createTestDb();
  context.after(() => db.close());
  const logger = recordingLogger();
  class BrokenGateway extends InMemoryGateway {
    public override async fetchWalletAddress(): Promise<WalletAddressLookup> {
      throw new Error("boom");
    }
  }
  const verifier = new WalletVerifier({
    gateway: new BrokenGateway(),
    pendingLogins: new PendingLoginRepo(db),
    log: logger.log,
  });
  const outcome = await verifier.start("uid-1", WALLET_ADDRESS, CALLBACK);
  assert.deepEqual(outcome, { kind: "failed", reason: "Something went wrong. Please try again." });
  assert.deepEqual(logger.calls, [
    {
      level: "error",
      msg: "login.start",
      fields: { outcome: "failed", reason: "internal error", error: "boom" },
    },
  ]);
});

test("start logs login.start with wallet host, auth server origin and outcome", async (context) => {
  const { verifier, calls } = await setup(context);
  await verifier.start("uid-1", WALLET_ADDRESS, CALLBACK);
  assert.deepEqual(calls, [
    {
      level: "info",
      msg: "login.start",
      fields: {
        walletHost: WALLET_HOST,
        authServerOrigin: "https://auth.example",
        outcome: "redirect",
      },
    },
  ]);
});

test("start logs the host of what the user typed, and the lookup error", async (context) => {
  const { verifier, calls } = await setup(context, {
    lookup: {
      kind: "not_found",
      walletAddressUrl: "https://pointer.example/alice",
      error: "Not Found (status 404)",
    },
  });
  await verifier.start("uid-1", "$pointer.example/alice", CALLBACK);
  assert.deepEqual(calls, [
    {
      level: "info",
      msg: "login.start",
      fields: {
        walletHost: "pointer.example",
        reason: "wallet address fetch failed",
        error: "Not Found (status 404)",
        outcome: "invalid_input",
      },
    },
  ]);
});

test("start logs a grant failure as a warning with the auth server origin", async (context) => {
  const { verifier, calls } = await setup(context, { grant: { kind: "rejected", error: "nope" } });
  await verifier.start("uid-1", WALLET_ADDRESS, CALLBACK);
  assert.deepEqual(calls, [
    {
      level: "warn",
      msg: "login.start",
      fields: {
        walletHost: WALLET_HOST,
        authServerOrigin: "https://auth.example",
        reason: "grant request failed",
        error: "nope",
        outcome: "failed",
      },
    },
  ]);
});

test("finish logs login.finish verified with the wallet host", async (context) => {
  const { verifier, calls } = await started(context);
  await verifier.finish("uid-1", APPROVED);
  assert.deepEqual(calls, [
    {
      level: "info",
      msg: "login.finish",
      fields: { walletHost: WALLET_HOST, outcome: "verified" },
    },
  ]);
});

test("finish logs a failure reason as a warning", async (context) => {
  const { verifier, calls } = await started(context);
  await verifier.finish("uid-1", { ...APPROVED, hash: "bad" });
  assert.deepEqual(calls, [
    {
      level: "warn",
      msg: "login.finish",
      fields: { walletHost: WALLET_HOST, reason: "hash mismatch", outcome: "failed" },
    },
  ]);
});

test("finish for an unknown login logs without a wallet host", async (context) => {
  const { verifier, calls } = await setup(context);
  await verifier.finish("missing", { interactRef: "r", hash: "h" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.msg, "login.finish");
  assert.equal(calls[0]?.fields?.["outcome"], "failed");
  assert.equal("walletHost" in (calls[0]?.fields ?? {}), false);
});

test("logs never contain secrets or the full wallet address", async (context) => {
  for (const params of [APPROVED, { ...APPROVED, hash: "tampered" }]) {
    const { verifier, calls } = await setup(context, {
      continuation: { kind: "continued", subjectIds: [WALLET_ADDRESS], revokeError: "forbidden" },
    });
    await verifier.start("uid-1", WALLET_ADDRESS, CALLBACK);
    await verifier.finish("uid-1", params);
    const logged = JSON.stringify(calls);
    for (const secret of [CONTINUE_TOKEN, INTERACT_REF, INTERACT_NONCE, NONCE, params.hash ?? ""]) {
      assert.equal(logged.includes(secret), false, `log leaked ${secret}`);
    }
    assert.equal(logged.includes(WALLET_ADDRESS), false, "full wallet address was logged");
  }
});
