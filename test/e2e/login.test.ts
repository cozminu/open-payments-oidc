import assert from "node:assert/strict";
import { test } from "node:test";
import * as oidc from "openid-client";
import { createTestDb } from "../support/db.ts";
import type { FakeOptions } from "../support/fake-open-payments.ts";
import {
  FAKE_CONTINUE_TOKEN,
  FAKE_INTERACT_REF,
  FAKE_ISSUED_TOKEN,
} from "../support/fake-open-payments.ts";
import { CookieJar, follow, REDIRECT_URI, rsaKey, startTestApp } from "../support/test-app.ts";

const EXPIRED_COPY = "This login expired or was already used. Start again from the app.";

test("confidential client full login", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login();
  assert.equal(result.error, undefined);
  const claims = result.claims;
  assert.ok(claims);
  assert.equal(claims.sub, app.fake.walletAddress);
  assert.equal(claims.wallet_address, app.fake.walletAddress);
  assert.equal(claims.iss, app.issuer);
  assert.equal(claims.aud, "web");
  assert.equal(typeof claims.auth_time, "number");
  assert.equal(claims.nonce, result.nonce);
  assert.equal("email" in claims, false);
  assert.match(result.interaction?.html ?? "", /Sign in with your wallet address/);
  assert.equal(app.fake.grantRequests.length, 1);
  assert.equal(app.fake.continueRequests.length, 1);
});

test("id token carries only the expected claims", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login();
  assert.ok(result.claims);
  const allowed = ["sub", "wallet_address", "iss", "aud", "exp", "iat", "auth_time", "nonce"];
  // at_hash and sid are protocol claims oidc-provider adds; no user data in them.
  const extra = Object.keys(result.claims).filter(
    (key) => !allowed.includes(key) && key !== "at_hash" && key !== "sid",
  );
  assert.deepEqual(extra, []);
});

test("ID token is signed with the first key", async (t) => {
  const first = rsaKey("signing-first");
  const second = rsaKey("signing-second");
  const app = await startTestApp(t, { jwks: { keys: [first, second] } });
  const result = await app.login();
  assert.equal(result.error, undefined);
  assert.ok(result.tokens?.id_token);
  const header = JSON.parse(
    Buffer.from(result.tokens.id_token.split(".")[0] ?? "", "base64url").toString("utf8"),
  ) as { kid?: string; alg?: string };
  assert.equal(header.kid, "signing-first");
  assert.equal(header.alg, "RS256");
  // Both keys are published, so tokens signed with the older key stay verifiable after rotation.
  const jwks = (await (await fetch(`${app.url}/jwks`)).json()) as { keys: { kid: string }[] };
  assert.deepEqual(jwks.keys.map((key) => key.kid).sort(), ["signing-first", "signing-second"]);
});

test("public client with PKCE full login", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login({ client: "spa" });
  assert.equal(result.error, undefined);
  assert.equal(result.claims?.sub, app.fake.walletAddress);
  assert.equal(result.claims?.wallet_address, app.fake.walletAddress);
  assert.equal(result.claims?.aud, "spa");
});

test("userinfo returns sub and wallet_address", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login();
  assert.ok(result.tokens);
  const userinfo = await oidc.fetchUserInfo(
    result.config,
    result.tokens.access_token,
    app.fake.walletAddress,
  );
  assert.deepEqual(userinfo, {
    sub: app.fake.walletAddress,
    wallet_address: app.fake.walletAddress,
  });
});

test("denial returns access_denied", async (t) => {
  const app = await startTestApp(t, { fake: { approval: "reject" } });
  const result = await app.login();
  assert.equal(result.error, "access_denied");
  assert.equal(result.redirect?.searchParams.get("state"), result.state);
  assert.equal(result.redirect?.searchParams.get("code"), null);
  assert.equal(app.fake.continueRequests.length, 0);
});

test("bad hash returns server_error", async (t) => {
  const app = await startTestApp(t, { fake: { approval: "tamper" } });
  const result = await app.login();
  assert.equal(result.error, "server_error");
  assert.equal(result.redirect?.searchParams.get("code"), null);
  assert.equal(app.fake.continueRequests.length, 0);
});

test("wrong subject returns server_error", async (t) => {
  const app = await startTestApp(t, { fake: { verifiedPath: "/bob" } });
  const result = await app.login();
  assert.equal(result.error, "server_error");
  assert.equal(result.claims, undefined);
});

test("invalid wallet address re-renders form", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login({ walletAddresses: ["not a wallet <b>", app.fake.walletAddress] });
  const [invalid, valid] = result.formResponses;
  assert.equal(invalid?.status, 400);
  assert.match(invalid?.html ?? "", /doesn&#39;t look like a wallet address/);
  assert.match(invalid?.html ?? "", /Sign in with your wallet address/);
  assert.match(invalid?.html ?? "", /value="not a wallet &lt;b&gt;"/);
  assert.equal(valid?.status, 303);
  assert.equal(result.error, undefined);
  assert.equal(result.claims?.wallet_address, app.fake.walletAddress);
});

test("unsupported auth server re-renders form", async (t) => {
  const app = await startTestApp(t, { fake: { authServerOverride: "http://127.0.0.1:1/auth" } });
  const result = await app.login();
  assert.equal(result.formResponses[0]?.status, 400);
  assert.match(result.formResponses[0]?.html ?? "", /isn&#39;t supported yet/);
  assert.equal(app.fake.grantRequests.length, 0);
});

test("oversized form body is refused", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login({ walletAddresses: ["x".repeat(5000)] });
  assert.equal(result.formResponses[0]?.status, 413);
  assert.equal(app.fake.walletRequests.length, 0);
});

test("second login reuses session", async (t) => {
  const app = await startTestApp(t);
  const first = await app.login();
  assert.equal(first.error, undefined);
  const second = await app.login({ jar: first.jar });
  assert.equal(second.error, undefined);
  // No interaction page at all: the session's account got a grant via loadExistingGrant.
  assert.equal(second.interaction, undefined);
  assert.equal(app.fake.grantRequests.length, 1);
  assert.equal(second.claims?.sub, app.fake.walletAddress);
  assert.equal(second.claims?.wallet_address, app.fake.walletAddress);
  assert.equal(second.claims?.auth_time, first.claims?.auth_time);
});

test("second login with another client reuses session", async (t) => {
  const app = await startTestApp(t);
  const first = await app.login();
  const second = await app.login({ client: "spa", jar: first.jar });
  assert.equal(second.error, undefined);
  assert.equal(second.interaction, undefined);
  assert.equal(second.claims?.aud, "spa");
  assert.equal(app.fake.grantRequests.length, 1);
});

test("prompt=login forces wallet verification", async (t) => {
  const app = await startTestApp(t);
  const first = await app.login();
  const second = await app.login({ jar: first.jar, prompt: "login" });
  assert.equal(second.error, undefined);
  assert.match(new URL(second.interaction?.url ?? "").pathname, /^\/interaction\/[\w-]+$/);
  assert.equal(app.fake.grantRequests.length, 2);
  assert.equal(app.fake.continueRequests.length, 2);
  assert.equal(second.claims?.wallet_address, app.fake.walletAddress);
});

test("prompt=login with a denied wallet does not fall back to the session", async (t) => {
  // The fake reads its options per request, so the wallet can change its mind between logins.
  const fakeOptions: FakeOptions = {};
  const app = await startTestApp(t, { fake: fakeOptions });
  const first = await app.login();
  assert.equal(first.error, undefined);
  fakeOptions.approval = "reject";
  const second = await app.login({ jar: first.jar, prompt: "login" });
  assert.equal(second.error, "access_denied");
  assert.equal(second.tokens, undefined);
  assert.equal(app.fake.grantRequests.length, 2);
});

test("prompt=consent finishes with server_error", async (t) => {
  const app = await startTestApp(t);
  const first = await app.login();
  const second = await app.login({ jar: first.jar, prompt: "consent" });
  assert.equal(second.error, "server_error");
  assert.equal(second.redirect?.searchParams.get("code"), null);
  assert.equal(app.fake.grantRequests.length, 1);
});

test("prompt=consent without a session still never issues a code", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login({ prompt: "consent" });
  // The login prompt runs first (wallet verified), then the consent prompt is refused.
  assert.equal(app.fake.grantRequests.length, 1);
  assert.equal(result.error, "server_error");
  assert.equal(result.tokens, undefined);
});

test("callback replay", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login();
  assert.equal(result.error, undefined);
  assert.ok(result.callbackUrl);
  const replay = await follow(result.jar, result.callbackUrl);
  assert.equal(replay.redirect, undefined);
  assert.equal(replay.page?.status, 400);
  assert.match(replay.page?.html ?? "", new RegExp(EXPIRED_COPY));
  assert.equal(app.fake.continueRequests.length, 1);
});

test("callback replay before resume does not override the result", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login({ stopBeforeCallback: true });
  assert.ok(result.callbackUrl);
  const first = await result.jar.fetch(result.callbackUrl);
  assert.equal(first.status, 303);
  const resume = first.headers.get("location");
  assert.ok(resume);
  const replay = await result.jar.fetch(result.callbackUrl);
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), new RegExp(EXPIRED_COPY));
  const done = await follow(result.jar, new URL(resume, result.callbackUrl));
  assert.ok(done.redirect);
  assert.ok(done.redirect.searchParams.get("code"));
  assert.equal(app.fake.continueRequests.length, 1);
});

test("callback without the interaction cookie shows the expired page", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login({ stopBeforeCallback: true });
  assert.ok(result.callbackUrl);
  const response = await new CookieJar().fetch(result.callbackUrl);
  assert.equal(response.status, 400);
  assert.match(await response.text(), new RegExp(EXPIRED_COPY));
  assert.equal(app.fake.continueRequests.length, 0);
});

test("expired interaction", async (t) => {
  const app = await startTestApp(t);
  const result = await app.login({ stopBeforeCallback: true });
  assert.ok(result.callbackUrl);
  await app.db.query("DELETE FROM oidc_models WHERE model = 'Interaction'");
  const page = await follow(result.jar, result.callbackUrl);
  assert.equal(page.page?.status, 400);
  assert.match(page.page?.html ?? "", new RegExp(EXPIRED_COPY));
  assert.equal(app.fake.continueRequests.length, 0);
});

test("unknown interaction page shows the expired page", async (t) => {
  const app = await startTestApp(t);
  const response = await new CookieJar().fetch(`${app.url}/interaction/nope`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), new RegExp(EXPIRED_COPY));
});

test("cross-replica", async (t) => {
  const a = await startTestApp(t);
  const b = await startTestApp(t, { db: a.db, externalFake: a.fake, issuer: a.issuer });
  const result = await a.login({ callbackOrigin: b.url });
  assert.equal(result.error, undefined);
  assert.equal(result.claims?.wallet_address, a.fake.walletAddress);
  const verified = (line: { msg: string; outcome?: unknown }) =>
    line.msg === "login.finish" && line.outcome === "verified";
  assert.ok(b.logs.some(verified));
  assert.ok(!a.logs.some(verified));
});

test("healthz and readyz", async (t) => {
  const db = await createTestDb();
  const app = await startTestApp(t, { db });
  const health = await fetch(`${app.url}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok");
  const ready = await fetch(`${app.url}/readyz`);
  assert.equal(ready.status, 200);
  await db.close();
  const notReady = await fetch(`${app.url}/readyz`);
  assert.equal(notReady.status, 503);
  await notReady.body?.cancel();
});

test("wrong method on an interaction route is refused", async (t) => {
  const app = await startTestApp(t);
  const response = await fetch(`${app.url}/interaction/abc/callback`, { method: "POST" });
  assert.equal(response.status, 405);
  await response.body?.cancel();
});

test("rate limit returns 429", async (t) => {
  const app = await startTestApp(t, { limitPerMinute: 2 });
  const result = await app.login({
    walletAddresses: ["not a wallet 1", "not a wallet 2", "again"],
  });
  const statuses = result.formResponses.map((response) => response.status);
  assert.deepEqual(statuses, [400, 400, 429]);
  const limited = result.formResponses[2];
  assert.match(limited?.html ?? "", /Too many attempts, wait a minute and try again\./);
  assert.equal(app.fake.walletRequests.length, 0);
});

test("rate limit also covers the callback, before any wallet work", async (t) => {
  const app = await startTestApp(t, { limitPerMinute: 3 });
  const result = await app.login({ stopBeforeCallback: true });
  assert.ok(result.callbackUrl);
  // The POST used one; burn the rest with replays that fail cheaply, then the callback is refused.
  const cookie = result.jar;
  const bogus = new URL(result.callbackUrl);
  bogus.search = "?result=x";
  await cookie.fetch(new URL("/interaction/nope/callback", bogus)).then((r) => r.body?.cancel());
  await cookie.fetch(new URL("/interaction/nope/callback", bogus)).then((r) => r.body?.cancel());
  const blocked = await cookie.fetch(result.callbackUrl);
  assert.equal(blocked.status, 429);
  assert.match(await blocked.text(), /Too many attempts, wait a minute and try again\./);
  assert.equal(app.fake.continueRequests.length, 0);
});

test("logs contain no secrets", async (t) => {
  const app = await startTestApp(t, { fake: { returnAccessToken: true, revokeFails: true } });
  const result = await app.login();
  assert.equal(result.error, undefined);
  assert.ok(result.callbackUrl && result.redirect && result.tokens);
  const secrets = {
    continueToken: FAKE_CONTINUE_TOKEN,
    interactRef: FAKE_INTERACT_REF,
    issuedToken: FAKE_ISSUED_TOKEN,
    hash: result.callbackUrl.searchParams.get("hash"),
    code: result.redirect.searchParams.get("code"),
    idToken: result.tokens.id_token,
    accessToken: result.tokens.access_token,
  };
  for (const [name, value] of Object.entries(secrets)) {
    assert.ok(value, `${name} is available to scan for`);
  }
  assert.ok(app.lines.length > 0);
  for (const line of app.lines) {
    for (const [name, value] of Object.entries(secrets)) {
      assert.equal(line.includes(value ?? "missing"), false, `${name} leaked in: ${line}`);
    }
    assert.equal(line.includes(app.fake.walletAddress), false, `wallet address in: ${line}`);
    assert.equal(line.includes("interact_ref"), false);
  }
  const names = app.logs.map((line) => line.msg);
  assert.ok(names.includes("login.start"));
  assert.ok(names.includes("login.finish"));
  assert.ok(names.includes("token.revoke_failed"));
});

test("unexpected errors log http.error with the path only", async (t) => {
  const db = await createTestDb();
  const app = await startTestApp(t, { db });
  const result = await app.login({ stopBeforeCallback: true });
  assert.ok(result.callbackUrl);
  await db.close();
  const response = await result.jar.fetch(result.callbackUrl);
  assert.equal(response.status, 500);
  await response.body?.cancel();
  const entry = app.logs.find((line) => line.msg === "http.error");
  assert.ok(entry);
  assert.equal(entry.level, "error");
  assert.equal(entry["path"], new URL(result.callbackUrl).pathname);
  assert.equal(
    app.lines.some((line) => line.includes("hash=")),
    false,
  );
  assert.equal(
    app.lines.some((line) => line.includes(FAKE_INTERACT_REF)),
    false,
  );
});

test("grant and authorization errors are logged with the path and message only", async (t) => {
  const app = await startTestApp(t);
  const secretCode = "secret-authorization-code-value";
  const grant = await fetch(`${app.url}/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("web:web-secret-web-secret-web-secret").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: secretCode,
      redirect_uri: REDIRECT_URI,
    }),
  });
  assert.equal(grant.status, 400);
  const authorization = await fetch(
    `${app.url}/auth?${new URLSearchParams({
      client_id: "web",
      redirect_uri: REDIRECT_URI,
      response_type: "token",
      scope: "openid",
      state: "secret-state-value",
    })}`,
    { redirect: "manual" },
  );
  assert.equal(authorization.status, 303);
  const grantError = app.logs.find((line) => line.msg === "oidc.grant_error");
  assert.equal(grantError?.level, "warn");
  assert.equal(grantError?.["path"], "/token");
  assert.equal(grantError?.["error"], "invalid_grant");
  const authError = app.logs.find((line) => line.msg === "oidc.authorization_error");
  assert.equal(authError?.level, "warn");
  assert.equal(authError?.["path"], "/auth");
  for (const line of app.lines) {
    assert.equal(line.includes(secretCode), false, `code leaked in: ${line}`);
    assert.equal(line.includes("secret-state-value"), false, `state leaked in: ${line}`);
  }
});
