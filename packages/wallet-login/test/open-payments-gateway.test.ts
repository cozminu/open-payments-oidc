import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { GrantStart, OpenPaymentsGateway } from "../src/open-payments-gateway.ts";
import { OutboundPolicy } from "../src/outbound.ts";
import {
  createFakeOpenPayments,
  createTestGateway,
  FAKE_CONTINUE_TOKEN,
  FAKE_INTERACT_REF,
  FAKE_ISSUED_TOKEN,
  type Fake,
  type FakeOptions,
} from "../../../test/support/fake-open-payments.ts";
import { PUBLIC_ADDRESS, stubLookup } from "../../../test/support/lookup.ts";

const CALLBACK = "https://oidc.example/interaction/uid-1/callback";

/** A gateway with allowHttp, the only way to reach the fakes, and the fake's origin allowlisted. */
async function setup(
  context: TestContext,
  fakeOptions: FakeOptions = {},
  allowlist?: string[],
): Promise<{ fake: Fake; gateway: OpenPaymentsGateway }> {
  const fake = await createFakeOpenPayments(context, fakeOptions);
  const outbound = new OutboundPolicy({
    allowHttp: true,
    authServerOrigins: allowlist ?? [fake.url],
  });
  return { fake, gateway: await createTestGateway(context, outbound) };
}

async function strictGateway(
  context: TestContext,
  origins: string[],
): Promise<OpenPaymentsGateway> {
  const outbound = new OutboundPolicy({
    allowHttp: false,
    authServerOrigins: origins,
    lookup: stubLookup(PUBLIC_ADDRESS),
  });
  return createTestGateway(context, outbound);
}

function grantFor(fake: Fake) {
  return {
    walletAddressId: fake.walletAddress,
    authServer: fake.authServer,
    callbackUrl: CALLBACK,
    nonce: "client-nonce",
  };
}

async function requestPending(gateway: OpenPaymentsGateway, fake: Fake) {
  const grant = await gateway.requestGrant(grantFor(fake));
  assert.equal(grant.kind, "pending");
  if (grant.kind !== "pending") throw new Error("unreachable");
  return {
    continueUrl: grant.continueUrl,
    continueAccessToken: grant.continueAccessToken,
    interactRef: FAKE_INTERACT_REF,
  };
}

test("fetchWalletAddress returns the wallet address's id and auth server", async (context) => {
  const { fake, gateway } = await setup(context);
  assert.deepEqual(await gateway.fetchWalletAddress(fake.walletAddress), {
    kind: "found",
    walletAddressUrl: fake.walletAddress,
    walletAddressId: fake.walletAddress,
    authServer: fake.authServer,
  });
  assert.deepEqual(fake.walletRequests, ["/alice"]);
});

test("fetchWalletAddress rejects an unparseable address before any request", async (context) => {
  const { fake, gateway } = await setup(context);
  assert.deepEqual(await gateway.fetchWalletAddress("not a url"), { kind: "unparseable" });
  assert.equal(fake.walletRequests.length, 0);
});

test("fetchWalletAddress reports a wallet address that can't be fetched", async (context) => {
  const { fake, gateway } = await setup(context);
  const lookup = await gateway.fetchWalletAddress(`${fake.url}/nobody`);
  assert.equal(lookup.kind, "not_found");
  if (lookup.kind !== "not_found") throw new Error("unreachable");
  assert.equal(lookup.walletAddressUrl, `${fake.url}/nobody`);
  assert.match(lookup.error, /404/);
});

test("fetchWalletAddress refuses an auth server outside the allowlist", async (context) => {
  const other = await createFakeOpenPayments(context);
  for (const authServer of [other.authServer, "http://127.0.0.1:1/auth"]) {
    const { fake, gateway } = await setup(context, { authServerOverride: authServer });
    assert.deepEqual(await gateway.fetchWalletAddress(fake.walletAddress), {
      kind: "auth_server_not_allowed",
      walletAddressUrl: fake.walletAddress,
      authServer,
    });
  }
});

test("fetchWalletAddress accepts a wallet on any host whose auth server is allowlisted", async (context) => {
  const authFake = await createFakeOpenPayments(context);
  const { fake: walletFake, gateway } = await setup(
    context,
    { authServerOverride: authFake.authServer },
    [authFake.url],
  );
  const lookup = await gateway.fetchWalletAddress(walletFake.walletAddress);
  assert.equal(lookup.kind, "found");
  if (lookup.kind !== "found") throw new Error("unreachable");
  const grant = await gateway.requestGrant({
    ...grantFor(walletFake),
    authServer: lookup.authServer,
  });
  assert.equal(grant.kind, "pending");
  assert.equal(authFake.grantRequests.length, 1);
});

test("with allowHttp the SDK sends https wallet addresses over http", async (context) => {
  const { fake, gateway } = await setup(context);
  const https = fake.walletAddress.replace("http:", "https:");
  const lookup = await gateway.fetchWalletAddress(https);
  assert.equal(lookup.kind, "found");
  assert.deepEqual(fake.walletRequests, ["/alice"]);
});

test("without allowHttp an http wallet address is unparseable and nothing is fetched", async (context) => {
  const fake = await createFakeOpenPayments(context);
  const gateway = await strictGateway(context, [fake.url]);
  assert.deepEqual(await gateway.fetchWalletAddress(fake.walletAddress), { kind: "unparseable" });
  assert.equal(fake.walletRequests.length, 0);
});

test("without allowHttp a loopback wallet host is refused before any request", async (context) => {
  const fake = await createFakeOpenPayments(context);
  const outbound = new OutboundPolicy({ allowHttp: false, authServerOrigins: [fake.url] });
  const gateway = await createTestGateway(context, outbound);
  const url = `https://127.0.0.1:${new URL(fake.url).port}/alice`;
  const lookup = await gateway.fetchWalletAddress(url);
  assert.equal(lookup.kind, "host_refused");
  assert.equal(fake.walletRequests.length, 0);
});

test("requestGrant sends a subject-only interactive grant", async (context) => {
  const { fake, gateway } = await setup(context);
  const grant = await gateway.requestGrant(grantFor(fake));
  assert.deepEqual(grant, {
    kind: "pending",
    redirectUrl: `${fake.url}/interact/1`,
    interactNonce: "as-nonce-1",
    continueUrl: `${fake.url}/auth/continue/1`,
    continueAccessToken: FAKE_CONTINUE_TOKEN,
  } satisfies GrantStart);
  assert.equal(fake.grantRequests.length, 1);
  const body = fake.grantRequests[0] as Record<string, any>;
  assert.deepEqual(body.subject, { sub_ids: [{ id: fake.walletAddress, format: "uri" }] });
  assert.equal("access_token" in body, false);
  assert.deepEqual(body.interact, {
    start: ["redirect"],
    finish: { method: "redirect", uri: CALLBACK, nonce: "client-nonce" },
  });
});

test("requestGrant sends nothing to an auth server the policy refuses", async (context) => {
  // Allowlisted, but http with allowHttp off.
  const fake = await createFakeOpenPayments(context);
  const gateway = await strictGateway(context, [fake.url]);
  assert.deepEqual(await gateway.requestGrant(grantFor(fake)), { kind: "auth_server_not_allowed" });
  assert.equal(fake.grantRequests.length, 0);
});

test("requestGrant reports an auth server that can't be reached as rejected", async (context) => {
  const { fake, gateway } = await setup(context, {}, ["http://127.0.0.1:1"]);
  const grant = await gateway.requestGrant({
    ...grantFor(fake),
    authServer: "http://127.0.0.1:1/auth",
  });
  assert.equal(grant.kind, "rejected");
});

test("requestGrant refuses a continue url outside the allowlist", async (context) => {
  const other = await createFakeOpenPayments(context);
  const { fake, gateway } = await setup(context, {
    continueUriOverride: `${other.url}/auth/continue/1`,
  });
  assert.deepEqual(await gateway.requestGrant(grantFor(fake)), {
    kind: "continue_url_not_allowed",
  });
});

test("requestGrant refuses an interact redirect that isn't a safe browser redirect", async (context) => {
  const { fake, gateway } = await setup(context, {
    interactRedirectOverride: "javascript:alert(1)",
  });
  assert.deepEqual(await gateway.requestGrant(grantFor(fake)), {
    kind: "interact_redirect_not_allowed",
  });
});

test("continueGrant sends the interact ref with the continue token and returns the subject", async (context) => {
  const { fake, gateway } = await setup(context);
  const continuation = await gateway.continueGrant(await requestPending(gateway, fake));
  assert.deepEqual(continuation, { kind: "continued", subjectIds: [fake.walletAddress] });
  assert.deepEqual(fake.continueRequests, [
    { authorization: `GNAP ${FAKE_CONTINUE_TOKEN}`, body: { interact_ref: FAKE_INTERACT_REF } },
  ]);
  assert.equal(fake.revokeRequests.length, 0);
});

test("continueGrant returns whichever wallet address the auth server verified", async (context) => {
  const { fake, gateway } = await setup(context, { verifiedPath: "/bob" });
  const continuation = await gateway.continueGrant(await requestPending(gateway, fake));
  assert.deepEqual(continuation, { kind: "continued", subjectIds: [`${fake.url}/bob`] });
});

test("continueGrant never returns a subject id in a format other than uri", async (context) => {
  const { fake, gateway } = await setup(context, { subjectFormat: "opaque" });
  const continuation = await gateway.continueGrant(await requestPending(gateway, fake));
  // The SDK refuses the response today; if it ever passes it through, the id must be dropped.
  const ids = continuation.kind === "continued" ? (continuation.subjectIds ?? []) : [];
  assert.deepEqual(ids, []);
});

test("continueGrant reports a refused continuation as rejected", async (context) => {
  const { fake, gateway } = await setup(context);
  const request = await requestPending(gateway, fake);
  const continuation = await gateway.continueGrant({ ...request, continueAccessToken: "wrong" });
  assert.equal(continuation.kind, "rejected");
});

test("continueGrant sends nothing to a continue url outside the allowlist", async (context) => {
  const other = await createFakeOpenPayments(context);
  const { fake, gateway } = await setup(context);
  const request = await requestPending(gateway, fake);
  const continuation = await gateway.continueGrant({
    ...request,
    continueUrl: `${other.url}/auth/continue/1`,
  });
  assert.deepEqual(continuation, { kind: "continue_url_not_allowed" });
  assert.equal(other.continueRequests.length, 0);
});

test("continueGrant revokes an access token that came back", async (context) => {
  const { fake, gateway } = await setup(context, { returnAccessToken: true });
  const continuation = await gateway.continueGrant(await requestPending(gateway, fake));
  assert.deepEqual(continuation, { kind: "continued", subjectIds: [fake.walletAddress] });
  assert.deepEqual(fake.revokeRequests, [{ authorization: `GNAP ${FAKE_ISSUED_TOKEN}` }]);
});

test("continueGrant still revokes when the subject is wrong", async (context) => {
  const { fake, gateway } = await setup(context, { returnAccessToken: true, verifiedPath: "/bob" });
  await gateway.continueGrant(await requestPending(gateway, fake));
  assert.equal(fake.revokeRequests.length, 1);
});

test("continueGrant reports a failed revoke without failing the continuation", async (context) => {
  const { fake, gateway } = await setup(context, { returnAccessToken: true, revokeFails: true });
  const continuation = await gateway.continueGrant(await requestPending(gateway, fake));
  assert.equal(continuation.kind, "continued");
  if (continuation.kind !== "continued") throw new Error("unreachable");
  assert.deepEqual(continuation.subjectIds, [fake.walletAddress]);
  assert.match(continuation.revokeError ?? "", /403/);
  assert.equal(fake.revokeRequests.length, 1);
});

test("continueGrant sends no token to a manage url outside the allowlist", async (context) => {
  const other = await createFakeOpenPayments(context);
  const { fake, gateway } = await setup(context, {
    returnAccessToken: true,
    manageUrlOverride: `${other.url}/auth/token/1`,
  });
  const continuation = await gateway.continueGrant(await requestPending(gateway, fake));
  assert.deepEqual(continuation, { kind: "manage_url_not_allowed" });
  assert.equal(other.revokeRequests.length, 0);
  assert.equal(fake.revokeRequests.length, 0);
});
